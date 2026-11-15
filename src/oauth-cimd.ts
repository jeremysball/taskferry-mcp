import { isIP } from 'node:net';
import { isRecord, isStrings } from './json.ts';
import { cleanClientName, redirectAllowed } from './oauth-clients.ts';
import type { RedirectRules } from './oauth-config.ts';
import type { ClientView } from './oauth-store.ts';

// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00): the client_id
// is an https URL whose body is the client's registration. The authorization server fetches it
// on first sight, refuses a document that names a different URL, and caches it briefly.
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_DEFAULT_CACHE_MS = 5 * 60 * 1000;
export const CIMD_MIN_CACHE_MS = 60 * 1000;
export const CIMD_MAX_CACHE_MS = 60 * 60 * 1000;
export const CIMD_MAX_CACHE_ENTRIES = 100;
const CIMD_MAX_REDIRECT_URIS = 10;
const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];

// The part of fetch this module needs. Tests inject a function that answers with a Response.
export type CimdFetch = typeof fetch;

export type CimdOptions = {
  redirects: RedirectRules;
  log: (event: string, fields?: Record<string, string | number>) => void;
  now?: () => number;
  fetch?: CimdFetch;
};

export type CimdClient = ClientView & { cimd: true };

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.(18|19)\./,
  /^192\.0\.0\./,
  /^255\.255\.255\.255$/,
];

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const PRIVATE_V6 = [/^::1$/, /^::$/, /^f[cd][0-9a-f]{2}:/, /^fe[89ab][0-9a-f]:/, /^::ffff:127\./];

function privateAddress(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return PRIVATE_V4.some((pattern) => pattern.test(host));
  if (kind !== 6) return false;
  const bare = host.replace(/^\[|\]$/g, '');
  return PRIVATE_V6.some((pattern) => pattern.test(bare));
}

// SSRF guard for literal addresses and obviously local names. DNS that resolves to a private
// address is not caught here; see docs/things-that-look-like-bugs.md.
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return privateAddress(host);
}

// Returns the parsed client_id URL, or undefined when it is not a valid CIMD identifier: https,
// a path component, no dot segments, no credentials, no fragment.
export function parseClientIdUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.pathname === '/') return undefined;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
  // The URL parser removes dot segments while resolving, so the raw path has to be checked.
  const rawPath = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return url;
}

export const isClientIdUrl = (value: string) => parseClientIdUrl(value) !== undefined;

// The first thing about the document that disqualifies it, or undefined when it is acceptable.
function documentProblem(
  body: unknown,
  clientId: string,
  redirects: RedirectRules,
): string | undefined {
  if (!isRecord(body)) return 'not_object';
  if (body.client_id !== clientId) return 'client_id_mismatch';
  if (hasSharedSecret(body)) return 'client_secret';
  if (!validAuthMethod(body)) return 'auth_method';
  const metadata = metadataProblem(body);
  if (metadata) return metadata;
  return allowedRedirects(body.redirect_uris, redirects).length > 0 ? undefined : 'redirect_uris';
}

function hasSharedSecret(body: Record<string, unknown>): boolean {
  return body.client_secret !== undefined || body.client_secret_expires_at !== undefined;
}

function validAuthMethod(body: Record<string, unknown>): boolean {
  const method = body.token_endpoint_auth_method;
  return method === undefined || method === 'none';
}

function metadataProblem(body: Record<string, unknown>): string | undefined {
  if (body.grant_types !== undefined && !validGrants(body.grant_types)) return 'grant_types';
  if (body.response_types !== undefined && !validResponseTypes(body.response_types)) {
    return 'response_types';
  }
  return undefined;
}

function validGrants(value: unknown): boolean {
  return (
    isStrings(value) &&
    value.includes('authorization_code') &&
    value.every((grant) => SUPPORTED_GRANTS.includes(grant))
  );
}

function validResponseTypes(value: unknown): boolean {
  return isStrings(value) && value.includes('code');
}

// The document registers the redirect URIs, but the operator's allowlist still decides which
// destinations this server will send a code to.
function allowedRedirects(value: unknown, redirects: RedirectRules): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CIMD_MAX_REDIRECT_URIS) {
    return [];
  }
  return [
    ...new Set(
      value.filter(
        (uri): uri is string => typeof uri === 'string' && redirectAllowed(redirects, uri),
      ),
    ),
  ];
}

type CacheEntry = { client: CimdClient; expiresAt: number };

export class CimdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly options: CimdOptions;
  private readonly now: () => number;
  private readonly fetchImpl: CimdFetch;

  constructor(options: CimdOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
  }

  // A registered client always wins; a URL-shaped id is fetched and validated. Any failure is an
  // unknown client: the caller shows an error here rather than redirecting.
  async resolve(clientId: string): Promise<CimdClient | undefined> {
    const url = parseClientIdUrl(clientId);
    if (!url || privateHost(url.hostname)) return undefined;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.now()) return cached.client;
    if (cached) this.cache.delete(clientId);
    const document = await this.fetchDocument(clientId);
    if (!document) return undefined;
    const client = this.accept(clientId, document);
    if (!client) return undefined;
    this.remember(clientId, client, document.maxAgeMs);
    return client;
  }

  private remember(clientId: string, client: CimdClient, maxAgeMs: number | undefined) {
    // `no-store` (or max-age=0) wins over the lower clamp.
    if (maxAgeMs === 0) return;
    while (this.cache.size >= CIMD_MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    const ttl = Math.min(
      CIMD_MAX_CACHE_MS,
      Math.max(CIMD_MIN_CACHE_MS, maxAgeMs ?? CIMD_DEFAULT_CACHE_MS),
    );
    this.cache.set(clientId, { client, expiresAt: this.now() + ttl });
  }

  private async fetchDocument(
    url: string,
  ): Promise<{ body: unknown; maxAgeMs: number | undefined } | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      this.options.log('cimd_fetch_failed', { reason: (error as Error).name });
      return undefined;
    }
    // A redirect is a different document than the one the client_id names, so it is refused.
    if (response.status !== 200) {
      this.options.log('cimd_fetch_failed', { status: response.status });
      return undefined;
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' && !type.endsWith('+json')) {
      this.options.log('cimd_fetch_failed', { reason: 'content_type' });
      return undefined;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > CIMD_MAX_BYTES) {
      this.options.log('cimd_fetch_failed', { reason: 'too_large' });
      return undefined;
    }
    const text = await readCapped(response);
    if (text === undefined) {
      this.options.log('cimd_fetch_failed', { reason: 'too_large' });
      return undefined;
    }
    try {
      return { body: JSON.parse(text), maxAgeMs: cacheMaxAge(response.headers) };
    } catch {
      this.options.log('cimd_fetch_failed', { reason: 'not_json' });
      return undefined;
    }
  }

  private accept(clientId: string, document: { body: unknown }): CimdClient | undefined {
    const body = document.body;
    const problem = documentProblem(body, clientId, this.options.redirects);
    if (problem) {
      this.options.log('cimd_invalid_document', { reason: problem });
      return undefined;
    }
    return {
      clientId,
      clientName: cleanClientName((body as Record<string, unknown>).client_name),
      redirectUris: allowedRedirects(
        (body as Record<string, unknown>).redirect_uris,
        this.options.redirects,
      ),
      cimd: true,
    };
  }
}

function cacheMaxAge(headers: Headers): number | undefined {
  const cacheControl = headers.get('cache-control') ?? '';
  if (/\bno-store\b/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  return match ? Number(match[1]) * 1000 : undefined;
}

async function readCapped(response: Response): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CIMD_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

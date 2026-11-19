import { isIP } from 'node:net';
import https from 'node:https';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';
import { isRecord, isStrings } from './json.ts';
import { MAX_REDIRECT_URI_CHARS, cleanClientName, redirectAllowed } from './oauth-clients.ts';
import type { RedirectRules } from './oauth-config.ts';
import type { ClientView } from './oauth-store.ts';
import { pinnedLookup, resolveCallbackTarget } from './webhook.ts';

// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00): the client_id
// is an https URL whose body is the client's registration. The authorization server fetches it
// on first sight, refuses a document that names a different URL, and caches it briefly.
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_DEFAULT_CACHE_MS = 5 * 60 * 1000;
export const CIMD_MIN_CACHE_MS = 60 * 1000;
export const CIMD_MAX_CACHE_MS = 60 * 60 * 1000;
export const CIMD_MAX_CACHE_ENTRIES = 100;
export const CIMD_MAX_INFLIGHT = 20;
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

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// SSRF guard for literal addresses and obviously local names. Every IP literal is refused, so an
// IPv6 form cannot be mistaken for a hostname, and one trailing dot is ignored so `localhost.`
// cannot slip past the local-name checks. DNS addresses are checked by the pinned transport.
function privateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(host) !== 0) return true;
  if (host === 'localhost') return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// The URL parser removes dot segments while resolving, so the raw path has to be checked. A
// segment is also decoded first, because `%2e%2e` is a dot segment to the origin server.
function dotSegment(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
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
  const rawPath = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  if (rawPath.split('/').some(dotSegment)) return undefined;
  return url;
}

export const isClientIdUrl = (value: string) => parseClientIdUrl(value) !== undefined;

class DeflateDecoder extends Transform {
  private decoder?: ReturnType<typeof createInflate>;

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
    if (!this.decoder && chunk.length) {
      this.decoder = (chunk[0] & 15) === 8 ? createInflate() : createInflateRaw();
      this.decoder.on('data', (data: Buffer) => this.push(data));
      this.decoder.on('error', (error) => this.destroy(error));
    }
    if (this.decoder) this.decoder.write(chunk, callback);
    else callback();
  }

  override _final(callback: TransformCallback) {
    if (this.decoder) this.decoder.end(callback);
    else callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.decoder?.destroy();
    callback(error);
  }
}

function cappedDecoderStages(decoders: Transform[]): Transform[] {
  return decoders.flatMap((decoder, index) => {
    if (index === decoders.length - 1) return [decoder];
    let size = 0;
    return [
      decoder,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > CIMD_MAX_BYTES ? new Error('decoded body too large') : null, chunk);
        },
      }),
    ];
  });
}

async function pinnedFetch(
  input: string | URL | Request,
  init?: Parameters<CimdFetch>[1],
): Promise<Response> {
  const target = await resolveCallbackTarget(String(input), {
    preserveTrailingDot: true,
    dnsPurpose: 'cimd',
  });
  init?.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: target.url.hostname,
        port: target.url.port || 443,
        path: target.url.href.slice(target.url.origin.length),
        method: 'GET',
        headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' },
        agent: false,
        lookup: pinnedLookup(target, target.addresses) as NonNullable<
          https.RequestOptions['lookup']
        >,
        ...{ autoSelectFamily: true },
        signal: init?.signal ?? undefined,
      },
      (response) => {
        try {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          }
          const status = response.statusCode ?? 500;
          if (status !== 200) {
            response.destroy();
            resolve(new Response(null, { status, headers }));
            return;
          }
          const encodings = (headers.get('content-encoding') ?? '')
            .toLowerCase()
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
          if (encodings.length > 3) throw new Error('too many content encodings');
          const decoders = encodings.reverse().map((encoding) => {
            if (encoding === 'gzip') return createGunzip();
            if (encoding === 'deflate') return new DeflateDecoder();
            if (encoding === 'br') return createBrotliDecompress();
            return undefined;
          });
          let stream: Readable = response;
          if (decoders.length && decoders.every((decoder) => decoder !== undefined)) {
            const stages = cappedDecoderStages(decoders);
            pipeline([response, ...stages], () => {});
            stream = stages[stages.length - 1];
          }
          const body = Readable.toWeb(stream) as ReadableStream;
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.on('close', () => reject(new Error('metadata request closed before response')));
    request.end();
  });
}

type DocumentVerdict = { redirectUris: string[] } | { reason: string };

// The redirect list is validated once here, so the same filtered list both decides acceptance
// and becomes the client; a second pass could disagree with the first.
function documentVerdict(
  body: unknown,
  clientId: string,
  redirects: RedirectRules,
): DocumentVerdict {
  if (!isRecord(body)) return { reason: 'not_object' };
  if (body.client_id !== clientId) return { reason: 'client_id_mismatch' };
  if (hasSharedSecret(body)) return { reason: 'client_secret' };
  if (!validAuthMethod(body)) return { reason: 'auth_method' };
  const metadata = metadataProblem(body);
  if (metadata) return { reason: metadata };
  const redirectUris = allowedRedirects(body.redirect_uris, redirects);
  return redirectUris.length > 0 ? { redirectUris } : { reason: 'redirect_uris' };
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

// Registration accepts exactly ["code"], so a metadata document may not register a broader set.
function validResponseTypes(value: unknown): boolean {
  return isStrings(value) && value.length === 1 && value[0] === 'code';
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
        (uri): uri is string =>
          typeof uri === 'string' &&
          uri.length <= MAX_REDIRECT_URI_CHARS &&
          redirectAllowed(redirects, uri),
      ),
    ),
  ];
}

type CacheEntry = { client: ClientView; expiresAt: number };

export class CimdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ClientView | undefined>>();
  private readonly options: CimdOptions;
  private readonly now: () => number;
  private readonly fetchImpl: CimdFetch;

  constructor(options: CimdOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? pinnedFetch;
  }

  // A registered client always wins; a URL-shaped id is fetched and validated. Any failure is an
  // unknown client: the caller shows an error here rather than redirecting.
  async resolve(clientId: string): Promise<ClientView | undefined> {
    const url = parseClientIdUrl(clientId);
    if (!url || privateHost(url.hostname)) return undefined;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.now()) return cached.client;
    if (cached) this.cache.delete(clientId);
    return this.load(clientId);
  }

  // One fetch per client id at a time, so a burst of sign-ins naming the same document shares
  // one answer. The cap bounds distinct ids, which the cache cannot: it holds only completed
  // fetches, and a burst of distinct ids would otherwise run unbounded in parallel.
  private load(clientId: string): Promise<ClientView | undefined> {
    const shared = this.inflight.get(clientId);
    if (shared) return shared;
    if (this.inflight.size >= CIMD_MAX_INFLIGHT) {
      this.options.log('cimd_fetch_failed', { reason: 'busy' });
      return Promise.resolve(undefined);
    }
    const task = this.loadOnce(clientId).finally(() => this.inflight.delete(clientId));
    this.inflight.set(clientId, task);
    return task;
  }

  private async loadOnce(clientId: string): Promise<ClientView | undefined> {
    const document = await this.fetchDocument(clientId);
    if (!document) return undefined;
    const client = this.accept(clientId, document);
    if (!client) return undefined;
    this.remember(clientId, client, document.maxAgeMs);
    return client;
  }

  private remember(clientId: string, client: ClientView, maxAgeMs: number | undefined) {
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

  // An early rejection still has a response body to release; leaving it unread can pin the
  // connection until the server or the timeout gives up.
  private discard(response: Response) {
    if (response.body) void response.body.cancel().catch(() => {});
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
      this.discard(response);
      return undefined;
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' && !type.endsWith('+json')) {
      this.options.log('cimd_fetch_failed', { reason: 'content_type' });
      this.discard(response);
      return undefined;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > CIMD_MAX_BYTES) {
      this.options.log('cimd_fetch_failed', { reason: 'too_large' });
      this.discard(response);
      return undefined;
    }
    const body = await readCapped(response);
    if ('reason' in body) {
      this.options.log('cimd_fetch_failed', { reason: body.reason });
      return undefined;
    }
    try {
      return { body: JSON.parse(body.text), maxAgeMs: cacheMaxAge(response.headers) };
    } catch {
      this.options.log('cimd_fetch_failed', { reason: 'not_json' });
      return undefined;
    }
  }

  private accept(clientId: string, document: { body: unknown }): ClientView | undefined {
    const verdict = documentVerdict(document.body, clientId, this.options.redirects);
    if ('reason' in verdict) {
      this.options.log('cimd_invalid_document', { reason: verdict.reason });
      return undefined;
    }
    const body = document.body as Record<string, unknown>;
    return {
      clientId,
      clientName: cleanClientName(body.client_name),
      redirectUris: verdict.redirectUris,
    };
  }
}

// A missing Cache-Control means the default TTL; anything present but unusable (`no-cache`, a
// non-numeric max-age) means the document must not be reused.
function cacheMaxAge(headers: Headers): number | undefined {
  const cacheControl = headers.get('cache-control');
  if (cacheControl === null) return undefined;
  if (/\bno-store\b/i.test(cacheControl) || /\bno-cache\b/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age=(?:"?(\d+)"?)\s*(?:,|$)/i.exec(cacheControl);
  if (match) return Number(match[1]) * 1000;
  return /\bmax-age=/i.test(cacheControl) ? 0 : undefined;
}

type CappedBody = { text: string } | { reason: 'too_large' | 'read_failed' };

async function readCapped(response: Response): Promise<CappedBody> {
  if (!response.body) return { text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CIMD_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    // A body that fails mid-stream (abort, reset) is a failed fetch, not an oversized one.
    await reader.cancel().catch(() => {});
    return { reason: 'read_failed' };
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged) };
}

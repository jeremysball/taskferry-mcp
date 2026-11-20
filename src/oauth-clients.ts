import { isLoopbackHost, parseWebUrl, type RedirectRules } from './oauth-config.ts';

const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_CHARS = 2048;
const MAX_NAME_CHARS = 100;
const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];
const DEFAULT_NAME = 'Unnamed client';

export type Registration = { clientName: string; redirectUris: string[]; grantTypes: string[] };
export type RegistrationResult =
  | { ok: true; value: Registration }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

const fail = (
  error: 'invalid_redirect_uri' | 'invalid_client_metadata',
  description: string,
): RegistrationResult => ({ ok: false, error, description });

// A redirect this server will ever send a code to: https, or http on a loopback host (RFC 8252).
// Credentials in the URL and fragments are refused outright.
function parseRedirect(value: string): URL | undefined {
  try {
    return parseWebUrl('redirect URI', value);
  } catch {
    return undefined;
  }
}

// Policy, not just syntax: a client may only register a redirect the operator allowed. Without
// this, anyone who can reach the registration endpoint could point an approval at their own host.
export function redirectAllowed(rules: RedirectRules, value: string): boolean {
  const url = parseRedirect(value);
  if (!url) return false;
  if (rules.exact.includes(url.href)) return true;
  return rules.loopback && url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

// Control and bidi-override characters would let a client name spoof the consent page.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

export function cleanClientName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NAME;
  const cleaned = value.replace(UNSAFE_NAME_CHARS, '').trim().slice(0, MAX_NAME_CHARS);
  return cleaned === '' ? DEFAULT_NAME : cleaned;
}

function validRedirects(value: unknown, rules: RedirectRules): string[] | RegistrationResult {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    return fail('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  for (const uri of value) {
    if (typeof uri !== 'string' || uri.length > MAX_REDIRECT_URI_CHARS) {
      return fail('invalid_redirect_uri', 'every redirect URI must be a string of sane length');
    }
    if (!redirectAllowed(rules, uri)) {
      return fail(
        'invalid_redirect_uri',
        'a redirect URI is not allowed by this server; the operator must allow it',
      );
    }
  }
  return value as string[];
}

function validGrants(value: unknown): string[] | undefined {
  if (value === undefined) return [...SUPPORTED_GRANTS];
  const ok =
    Array.isArray(value) &&
    value.includes('authorization_code') &&
    value.every((g) => typeof g === 'string' && SUPPORTED_GRANTS.includes(g));
  return ok ? (value as string[]) : undefined;
}

// Client authentication and response types are fixed by what this server offers.
function unsupportedMetadata(meta: Record<string, unknown>): string | undefined {
  const method = meta.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    return 'only token_endpoint_auth_method "none" is supported';
  }
  const types = meta.response_types;
  const onlyCode = Array.isArray(types) && types.length === 1 && types[0] === 'code';
  return types !== undefined && !onlyCode ? 'only response_types ["code"] is supported' : undefined;
}

// RFC 7591 registration for a public client. Only the authorization-code flow with PKCE is
// offered, so any other grant, response type or client authentication method is refused rather
// than silently ignored.
export function parseRegistration(body: unknown, rules: RedirectRules): RegistrationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('invalid_client_metadata', 'registration body must be a JSON object');
  }
  const meta = body as Record<string, unknown>;
  const redirects = validRedirects(meta.redirect_uris, rules);
  if (!Array.isArray(redirects)) return redirects;
  const grants = validGrants(meta.grant_types);
  if (!grants) {
    return fail('invalid_client_metadata', 'grant_types must include authorization_code');
  }
  const unsupported = unsupportedMetadata(meta);
  if (unsupported) return fail('invalid_client_metadata', unsupported);
  return {
    ok: true,
    value: {
      clientName: cleanClientName(meta.client_name),
      redirectUris: redirects,
      grantTypes: grants,
    },
  };
}

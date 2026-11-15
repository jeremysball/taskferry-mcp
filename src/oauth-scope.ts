// One real scope: a granted client gets the whole tool surface, the same authority the static
// bearer token carries. `offline_access` is accepted because Claude appends it when the server
// lists it, but it grants nothing extra: a refresh token is always issued.
export const SCOPE = 'taskferry';
export const OFFLINE_ACCESS = 'offline_access';
export const SCOPES_SUPPORTED = [SCOPE, OFFLINE_ACCESS];

// Resolves a requested scope string to the scopes that will be granted. No scope means the
// default; a request that names only `offline_access` is refused rather than upgraded to the full
// scope, and any value this server does not know is a refusal, not a silent drop.
export function parseScope(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return [SCOPE];
  const requested = raw.split(' ').filter((item) => item !== '');
  if (!requested.includes(SCOPE)) return undefined;
  if (!requested.every((item) => SCOPES_SUPPORTED.includes(item))) return undefined;
  return [SCOPE];
}

// RFC 8707 resource identifiers compare as absolute URIs. A fragment is never part of one, and
// one trailing slash is ignored; nothing else is, so a sibling path or another host never matches.
export function sameResource(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.href.replace(/\/$/, '') === right.href.replace(/\/$/, '');
  } catch {
    return false;
  }
}

import type http from 'node:http';
import type { OAuthConfig } from './oauth-config.ts';
import type { FailureLimiter } from './oauth-limiter.ts';
import type { OAuthStore } from './oauth-store.ts';

export const MAX_OAUTH_BODY_BYTES = 16 * 1024;

// Audit lines carry ids and outcomes only. A secret, code or token must never reach a log.
export type OAuthLog = (event: string, fields?: Record<string, string | number>) => void;
export const consoleLog: OAuthLog = (event, fields = {}) => {
  console.error(JSON.stringify({ event: `oauth.${event}`, ...fields }));
};

// Set on every OAuth response. The consent page must not be framed (clickjacking) or cached, and
// must not leak its URL through Referer. No `form-action` directive: Chrome applies it to the
// redirect that follows the form POST, which would block the hand-off back to the client.
export const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;

export type OAuthDeps = {
  config: OAuthConfig;
  store: OAuthStore;
  limiter: FailureLimiter;
  log: OAuthLog;
};

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

// Reads a request body as UTF-8 text, refusing anything over `limit` bytes. Past the limit it stops
// buffering and marks the response `Connection: close`, so the caller's error response is
// delivered and then the connection is dropped. Destroying the socket here instead would cut that
// response off before the client could read it.
export function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit = MAX_OAUTH_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        res.setHeader('connection', 'close');
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

// RFC 6749 section 5.2 error body. `description` is for developers, never user-controlled markup.
export function sendOAuthError(
  res: http.ServerResponse,
  status: number,
  error: string,
  description?: string,
) {
  sendJson(res, status, description ? { error, error_description: description } : { error });
}

export function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function redirect(res: http.ServerResponse, location: string) {
  res.writeHead(302, { ...SECURITY_HEADERS, location });
  res.end();
}

export function isFormContent(req: http.IncomingMessage): boolean {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/x-www-form-urlencoded';
}

export function methodNotAllowed(res: http.ServerResponse, allow: string) {
  res.writeHead(405, { ...SECURITY_HEADERS, allow });
  res.end();
}

// The first value of a form or query field, or undefined when it is absent or repeated. A
// repeated parameter is ambiguous (RFC 6749 section 3.1), so it is treated as missing.
export function single(params: URLSearchParams, name: string): string | undefined {
  const all = params.getAll(name);
  return all.length === 1 ? all[0] : undefined;
}

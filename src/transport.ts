import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  isJsonContentType,
  validateHostHeader,
  validateOriginHeader,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
} from '@modelcontextprotocol/server';

export const MAX_REQUEST_BYTES = 1024 * 1024;
// What the transport needs from the OAuth layer, kept structural so this file does not import it.
export type BearerVerifier = {
  verify: (token: string) => boolean;
  challenge: (presented: boolean) => string;
  // The public hostname the bridge is reached by, allowed alongside loopback names.
  hostname: string;
};
export type RequestGuard = { token: string; loopback: boolean; oauth?: BearerVerifier };

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// DNS-rebinding guard for the loopback TCP listener. A tunnel in front of it forwards the public
// hostname, so that one name is accepted too when OAuth is on; matching is hostname-only.
export function loopbackRequest(req: http.IncomingMessage, publicHostname?: string): boolean {
  const extra = publicHostname === undefined ? [] : [publicHostname];
  return (
    validateHostHeader(req.headers.host, [...localhostAllowedHostnames(), ...extra]).ok &&
    req.headers.origin !== '' &&
    validateOriginHeader(req.headers.origin, [...localhostAllowedOrigins(), ...extra]).ok
  );
}

export function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

// The first status that must stop this request before the MCP handler, or undefined to let it
// through. A static bearer token always works; an OAuth access token works when OAuth is on.
function authenticated(req: http.IncomingMessage, guard: RequestGuard): boolean {
  if (constantTimeEqual(req.headers.authorization ?? '', `Bearer ${guard.token}`)) return true;
  const presented = bearerToken(req);
  return presented !== undefined && guard.oauth?.verify(presented) === true;
}

export function transportRefusal(
  req: http.IncomingMessage,
  guard: RequestGuard,
): number | undefined {
  if (req.url !== '/mcp') return 404;
  if (!authenticated(req, guard)) return 401;
  if (req.method !== 'POST') return 405;
  if (!isJsonContentType(req.headers['content-type'] ?? null)) return 415;
  if (guard.loopback && !loopbackRequest(req, guard.oauth?.hostname)) return 403;
  return undefined;
}

// A 401 carries the OAuth challenge only when OAuth is configured; otherwise it is the plain
// `Bearer` it always was.
export function refuse(
  res: http.ServerResponse,
  status: number,
  req?: http.IncomingMessage,
  oauth?: BearerVerifier,
): void {
  res.setHeader('Cache-Control', 'no-store');
  if (status === 401) {
    const presented = req !== undefined && bearerToken(req) !== undefined;
    res.setHeader('WWW-Authenticate', oauth ? oauth.challenge(presented) : 'Bearer');
  }
  if (status === 405) res.setHeader('Allow', 'POST');
  res.writeHead(status).end();
}

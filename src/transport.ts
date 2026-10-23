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
export type RequestGuard = { token: string; loopback: boolean };

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function loopbackRequest(req: http.IncomingMessage): boolean {
  return (
    validateHostHeader(req.headers.host, localhostAllowedHostnames()).ok &&
    req.headers.origin !== '' &&
    validateOriginHeader(req.headers.origin, localhostAllowedOrigins()).ok
  );
}

export function transportRefusal(
  req: http.IncomingMessage,
  guard: RequestGuard,
): number | undefined {
  if (req.url !== '/mcp') return 404;
  if (!constantTimeEqual(req.headers.authorization ?? '', `Bearer ${guard.token}`)) return 401;
  if (req.method !== 'POST') return 405;
  if (!isJsonContentType(req.headers['content-type'] ?? null)) return 415;
  if (guard.loopback && !loopbackRequest(req)) return 403;
  return undefined;
}

export function refuse(res: http.ServerResponse, status: number): void {
  res.setHeader('Cache-Control', 'no-store');
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  if (status === 405) res.setHeader('Allow', 'POST');
  res.writeHead(status).end();
}

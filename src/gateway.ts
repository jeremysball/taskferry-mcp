import http from 'node:http';
import { MAX_REQUEST_BYTES, refuse, transportRefusal } from './transport.ts';
type Config = { upstreamUrl: string; inboundToken: string; upstreamToken: string };
const MCP_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;
export function createGateway(c: Config) {
  if (!c.inboundToken || !c.upstreamToken) throw Error('gateway credentials required');
  const dest = new URL(c.upstreamUrl);
  if (dest.pathname !== '/mcp' || !['http:', 'https:'].includes(dest.protocol))
    throw Error('invalid upstream configuration');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = transportRefusal(req, { token: c.inboundToken, loopback: true });
    if (status !== undefined) {
      refuse(res, status);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          refuse(res, 413);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${c.upstreamToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      for (const name of MCP_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = await fetch(dest, {
        headers,
        body: Buffer.concat(chunks, bytes),
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      const output = await upstream.text();
      if (Buffer.byteLength(output) > MAX_REQUEST_BYTES) throw Error('upstream response too large');
      for (const name of MCP_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      res
        .writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
        })
        .end(output);
    } catch {
      res.writeHead(502).end('upstream unavailable');
    }
  });
}
if (process.argv[1]?.endsWith('/gateway.ts')) {
  const app = createGateway({
    upstreamUrl: process.env.TASKFERRY_UPSTREAM_URL || '',
    inboundToken: process.env.TASKFERRY_GATEWAY_TOKEN || '',
    upstreamToken: process.env.TASKFERRY_MCP_TOKEN || '',
  });
  app.listen(Number(process.env.PORT || 8788), '127.0.0.1', () =>
    console.log('Gateway listening on loopback'),
  );
}

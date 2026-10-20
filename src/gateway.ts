import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
type Config = { upstreamUrl: string; inboundToken: string; upstreamToken: string };
function eq(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createGateway(c: Config) {
  if (!c.inboundToken || !c.upstreamToken) throw Error('gateway credentials required');
  const dest = new URL(c.upstreamUrl);
  if (dest.pathname !== '/mcp' || !['http:', 'https:'].includes(dest.protocol))
    throw Error('invalid upstream configuration');
  return http.createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!eq((req.headers.authorization || '').replace(/^Bearer /, ''), c.inboundToken)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) throw Error('too large');
      }
      const upstream = await fetch(dest, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${c.upstreamToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      const output = await upstream.text();
      if (Buffer.byteLength(output) > 1024 * 1024) throw Error('upstream response too large');
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

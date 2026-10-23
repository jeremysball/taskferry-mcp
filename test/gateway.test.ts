import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../src/gateway.ts';
import { send, serve, stop, TOKEN, rpc, splitInsideChar } from './helpers.ts';

async function gatewayFixture() {
  const calls: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    calls.push({ headers: req.headers, body });
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'response-session',
        'mcp-protocol-version': '2025-03-26',
      })
      .end(JSON.stringify({ ok: true }));
  });
  const upstreamUrl = await serve(upstream);
  const gateway = createGateway({
    upstreamUrl,
    inboundToken: TOKEN,
    upstreamToken: 'upstream-secret',
  });
  const url = await serve(gateway);
  return {
    url,
    calls,
    close: async () => {
      await stop(gateway);
      await stop(upstream);
    },
  };
}

test('gateway forwards authorized JSON without caching', async () => {
  const f = await gatewayFixture();
  try {
    const body = rpc('é');
    const result = await send(f.url, splitInsideChar(body));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
    assert.equal(f.calls[0].body, body);
    assert.equal(f.calls[0].headers.authorization, 'Bearer upstream-secret');
    assert.equal(result.headers['cache-control'], 'no-store');
  } finally {
    await f.close();
  }
});

const refusals = [
  {
    name: 'wrong token',
    status: 401,
    options: { token: 'wrong' },
    header: 'www-authenticate',
    value: 'Bearer',
  },
  { name: 'bare token', status: 401, options: { token: null, headers: { authorization: TOKEN } } },
  { name: 'foreign Host', status: 403, options: { headers: { host: 'evil.example' } } },
  { name: 'browser Origin', status: 403, options: { headers: { origin: 'https://evil.example' } } },
  { name: 'GET', status: 405, options: { method: 'GET' }, header: 'allow', value: 'POST' },
  { name: 'text/plain', status: 415, options: { headers: { 'content-type': 'text/plain' } } },
  {
    name: 'JSON substring',
    status: 415,
    options: { headers: { 'content-type': 'text/application/json' } },
  },
] as const;
for (const entry of refusals) {
  test(`gateway refuses ${entry.name}`, async () => {
    const f = await gatewayFixture();
    try {
      const result = await send(f.url, '', entry.options);
      assert.equal(result.status, entry.status);
      if ('header' in entry) assert.equal(result.headers[entry.header], entry.value);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
}

test('gateway refuses a body over 1 MiB with 413', async () => {
  const f = await gatewayFixture();
  try {
    const result = await send(f.url, 'x'.repeat(1024 * 1024 + 1));
    assert.equal(result.status, 413);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('gateway passes session and protocol headers in both directions', async () => {
  const f = await gatewayFixture();
  try {
    const result = await send(f.url, rpc('ping'), {
      headers: {
        'mcp-session-id': 'request-session',
        'mcp-protocol-version': '2025-11-25',
      },
    });
    assert.equal(f.calls[0].headers['mcp-session-id'], 'request-session');
    assert.equal(f.calls[0].headers['mcp-protocol-version'], '2025-11-25');
    assert.equal(result.headers['mcp-session-id'], 'response-session');
    assert.equal(result.headers['mcp-protocol-version'], '2025-03-26');
  } finally {
    await f.close();
  }
});

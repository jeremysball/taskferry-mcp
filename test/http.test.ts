import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { transportRefusal } from '../src/transport.ts';
import { HEALTH, fixture, rpc, send, splitInsideChar, toolCall } from './helpers.ts';

test('unauthenticated requests never touch the daemon, an authenticated read succeeds', async () => {
  const f = await fixture();
  try {
    for (const token of ['wrong', 'x', 'correct-secret-but-longer', '', null]) {
      const refused = await send(f.url, toolCall(HEALTH), { token });
      assert.equal(refused.status, 401, `token ${JSON.stringify(token)}`);
      assert.equal(refused.headers['www-authenticate'], 'Bearer');
    }
    assert.equal(f.calls.length, 0);
    const ok = await send(f.url, toolCall(HEALTH));
    assert.equal(ok.status, 200);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('only POST /mcp with a JSON body is served, and the answer is never cached', async () => {
  const f = await fixture();
  try {
    const other = new URL('/elsewhere', f.url).href;
    assert.equal((await send(other, toolCall(HEALTH))).status, 404);
    const get = await send(f.url, '', { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal((await send(f.url, '', { method: 'DELETE' })).status, 405);
    const plain = await send(f.url, toolCall(HEALTH), {
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.status, 415);
    const ok = await send(f.url, toolCall(HEALTH));
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('a malformed or oversized body is refused before any tool runs', async () => {
  const f = await fixture();
  try {
    const garbage = await send(f.url, '{not json');
    assert.equal(garbage.status, 400);
    assert.equal(JSON.parse(garbage.text).error.code, -32700);
    const huge = await send(f.url, toolCall(HEALTH, { pad: 'x'.repeat(1024 * 1024) }));
    assert.equal(huge.status, 413);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('a multibyte character split across request chunks survives', async () => {
  const f = await fixture();
  try {
    const body = splitInsideChar(JSON.stringify({ jsonrpc: '2.0', id: 'é', method: 'ping' }));
    const sent = await send(f.url, body);
    assert.equal(sent.status, 200);
    assert.equal(JSON.parse(sent.text).id, 'é');
  } finally {
    await f.close();
  }
});

test('on loopback TCP a foreign Host or Origin is refused, even with the token', async () => {
  const f = await fixture();
  try {
    const url = new URL(f.url);
    const hostile = await send(f.url, rpc('ping'), { headers: { host: 'evil.example' } });
    assert.equal(hostile.status, 403);
    const browser = await send(f.url, rpc('ping'), { headers: { origin: 'https://evil.example' } });
    assert.equal(browser.status, 403);
    const named = await send(f.url, rpc('ping'), { headers: { host: `localhost:${url.port}` } });
    assert.equal(named.status, 200);
    for (const host of ['[invalid']) {
      assert.equal((await send(f.url, rpc('ping'), { headers: { host } })).status, 403);
    }
    for (const origin of ['', 'null', 'not a URL']) {
      assert.equal((await send(f.url, rpc('ping'), { headers: { origin } })).status, 403);
    }
    const localOrigin = await send(f.url, rpc('ping'), {
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'Application/JSON; charset=utf-8',
      },
    });
    assert.equal(localOrigin.status, 200);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('the loopback guard refuses a missing or empty Host', () => {
  const req = new http.IncomingMessage(new net.Socket());
  req.url = '/mcp';
  req.method = 'POST';
  req.headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  assert.equal(transportRefusal(req, { token: 'secret', loopback: true }), 403);
  req.headers.host = '';
  assert.equal(transportRefusal(req, { token: 'secret', loopback: true }), 403);
  req.destroy();
});

test('JSON content type must match the media type, not a substring', async () => {
  const f = await fixture();
  try {
    const result = await send(f.url, rpc('ping'), {
      headers: { 'content-type': 'text/application/json' },
    });
    assert.equal(result.status, 415);
  } finally {
    await f.close();
  }
});

test('unexpected transport failures log the error and return a generic 500', async (t) => {
  const error = new Error('private transport failure');
  t.mock.method(NodeStreamableHTTPServerTransport.prototype, 'handleRequest', async () => {
    throw error;
  });
  const logged = t.mock.method(console, 'error', (..._args: unknown[]) => {});
  const f = await fixture();
  try {
    const result = await send(f.url, rpc('ping'));
    assert.equal(result.status, 500);
    assert.equal(result.text.includes(error.message), false);
    assert.equal(
      logged.mock.calls.some((call) => call.arguments.includes(error)),
      true,
    );
  } finally {
    await f.close();
  }
});

test('a request with no token is refused before its Host or Origin are weighed', async () => {
  const f = await fixture();
  try {
    const sent = await send(f.url, rpc('ping'), { token: null, headers: { host: 'evil.example' } });
    assert.equal(sent.status, 401);
  } finally {
    await f.close();
  }
});

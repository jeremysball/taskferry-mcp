import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH, fixture, rpc, send, splitInsideChar, toolCall } from './helpers.ts';

test('unauthenticated requests never touch the daemon, an authenticated read succeeds', async () => {
  const f = await fixture();
  try {
    for (const token of ['wrong', 'x', 'correct-secret-but-longer', '', null]) {
      const refused = await send(f.url, toolCall(HEALTH), { token });
      assert.equal(refused.status, 401, `token ${JSON.stringify(token)}`);
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

test('on loopback TCP a foreign Host or any browser Origin is refused, even with the token', async () => {
  const f = await fixture();
  try {
    const url = new URL(f.url);
    const hostile = await send(f.url, rpc('ping'), { headers: { host: 'evil.example' } });
    assert.equal(hostile.status, 403);
    const browser = await send(f.url, rpc('ping'), { headers: { origin: 'https://evil.example' } });
    assert.equal(browser.status, 403);
    const named = await send(f.url, rpc('ping'), { headers: { host: `localhost:${url.port}` } });
    assert.equal(named.status, 200);
    assert.equal(f.calls.length, 0);
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

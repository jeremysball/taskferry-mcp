import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { listenBridge } from '../src/listen.ts';
import { createGateway } from '../src/server.ts';
import {
  GATEWAY_TOKEN,
  HEALTH,
  TOKEN,
  bridgeConfig,
  call,
  mcpUrl,
  okReply,
  send,
  splitInsideChar,
  stubDaemon,
  toolCall,
} from './helpers.ts';

async function gatewayFixture() {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  // createGateway reads only the token; startSurfaces consumes gateway.port.
  const gateway = createGateway(
    bridgeConfig({
      daemonSocket: daemon.socket,
      gateway: { token: GATEWAY_TOKEN, port: 0 },
    }),
  );
  const listener = await listenBridge(gateway, { kind: 'tcp', port: 0 });
  const url = mcpUrl(gateway);
  let closed = false;
  return {
    url,
    calls: daemon.calls,
    close: async () => {
      if (closed) return;
      closed = true;
      await listener.close();
      await daemon.close();
    },
  };
}

test('the gateway surface serves MCP with its own token', async () => {
  const f = await gatewayFixture();
  try {
    const result = await call(f.url, toolCall(HEALTH), { token: GATEWAY_TOKEN });
    assert.notEqual(result.result?.isError, true);
    assert.equal(f.calls.length, 1);
    assert.equal((await send(f.url, toolCall(HEALTH), { token: TOKEN })).status, 401);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('the gateway accepts the legacy Accept header', async () => {
  const f = await gatewayFixture();
  try {
    const result = await send(f.url, toolCall(HEALTH), {
      token: GATEWAY_TOKEN,
      headers: { accept: '*/*' },
    });
    assert.equal(result.status, 200);
    assert.equal(f.calls.length, 1);
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
  {
    name: 'bare token',
    status: 401,
    options: { token: null, headers: { authorization: GATEWAY_TOKEN } },
  },
  {
    name: 'bridge token',
    status: 401,
    options: { token: TOKEN },
  },
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
      const result = await send(f.url, '', { token: GATEWAY_TOKEN, ...entry.options });
      assert.equal(result.status, entry.status);
      if ('header' in entry) assert.equal(result.headers[entry.header], entry.value);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
}

test('gateway refuses a body over 1 MiB with 413 and releases the connection', async () => {
  const f = await gatewayFixture();
  const target = new URL(f.url);
  const socket = net.connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  let text = '';
  const replied = new Promise<void>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('Payload Too Large')) resolve();
    });
  });
  try {
    socket.write(
      [
        `POST ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        `Authorization: Bearer ${GATEWAY_TOKEN}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `Content-Length: ${1024 * 1024 + 1}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.write('x'.repeat(1024));
    await replied;
    assert.match(text, /^HTTP\/1\.1 413/);
    assert.equal(f.calls.length, 0);
    const closeStarted = Date.now();
    await f.close();
    assert.ok(
      Date.now() - closeStarted < 2000,
      `close waited ${Date.now() - closeStarted}ms for an unread request body`,
    );
  } finally {
    socket.destroy();
    await f.close();
  }
});

test('the gateway reassembles a request split inside a multibyte character', async () => {
  const f = await gatewayFixture();
  try {
    const body = splitInsideChar(JSON.stringify({ jsonrpc: '2.0', id: 'é', method: 'ping' }));
    const result = await send(f.url, body, { token: GATEWAY_TOKEN });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).id, 'é');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveConfig } from '../src/config.ts';
import { startSurfaces } from '../src/server.ts';
import {
  GATEWAY_TOKEN,
  HEALTH,
  TOKEN,
  bridgeConfig,
  call,
  freePort,
  mcpUrl,
  okReply,
  removeDir,
  send,
  stop,
  stubDaemon,
  tempDir,
  toolCall,
} from './helpers.ts';

test('one process serves the bridge and gateway surfaces', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const surfaces = await startSurfaces(
    bridgeConfig({
      daemonSocket: daemon.socket,
      listen: { kind: 'tcp', port: 0 },
      gateway: { token: GATEWAY_TOKEN, port: 0 },
    }),
  );
  try {
    assert.ok(surfaces.gateway);
    const bridgeUrl = mcpUrl(surfaces.bridge);
    const gatewayUrl = mcpUrl(surfaces.gateway);
    for (const [url, token] of [
      [bridgeUrl, TOKEN],
      [gatewayUrl, GATEWAY_TOKEN],
    ] as const) {
      const result = await call(url, toolCall(HEALTH), { token });
      assert.notEqual(result.result?.isError, true);
    }
    assert.equal((await send(bridgeUrl, toolCall(HEALTH), { token: GATEWAY_TOKEN })).status, 401);
    assert.equal((await send(gatewayUrl, toolCall(HEALTH), { token: TOKEN })).status, 401);
    assert.equal(daemon.calls.length, 2);
  } finally {
    await surfaces.close();
    await daemon.close();
  }
});

test('a bridge-only start serves the bridge and closes it', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const surfaces = await startSurfaces(
    bridgeConfig({
      daemonSocket: daemon.socket,
      listen: { kind: 'tcp', port: 0 },
    }),
  );
  try {
    assert.equal(surfaces.gateway, undefined);
    const result = await call(mcpUrl(surfaces.bridge), toolCall(HEALTH), { token: TOKEN });
    assert.notEqual(result.result?.isError, true);
  } finally {
    await surfaces.close();
    await daemon.close();
  }
  assert.equal(surfaces.bridge.listening, false);
});

test('a gateway that cannot bind closes the bridge listener it was handed', async () => {
  const dir = tempDir('tf-surfaces-');
  const listenPath = path.join(dir, 'mcp.sock');
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      startSurfaces(
        bridgeConfig({
          daemonSocket: '/none',
          listen: { kind: 'unix', path: listenPath },
          gateway: { token: GATEWAY_TOKEN, port },
        }),
      ),
      /EADDRINUSE/,
    );
    assert.equal(existsSync(listenPath), false);
  } finally {
    await stop(blocker);
    removeDir(dir);
  }
});

test('a gateway constructor failure closes the bridge listener', async () => {
  const dir = tempDir('tf-surfaces-');
  const listenPath = path.join(dir, 'mcp.sock');
  try {
    await assert.rejects(
      startSurfaces(
        bridgeConfig({
          daemonSocket: '/none',
          listen: { kind: 'unix', path: listenPath },
          gateway: { token: TOKEN, port: 4321 },
        }),
      ),
      /gateway token must differ from the bridge token/,
    );
    assert.equal(existsSync(listenPath), false);
  } finally {
    removeDir(dir);
  }
});

test('startSurfaces honors the gateway port resolved from config', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const dir = tempDir('tf-surfaces-config-');
  const bridgePort = await freePort();
  let gatewayPort = await freePort();
  while (gatewayPort === bridgePort) gatewayPort = await freePort();
  try {
    const config = resolveConfig({
      argv: ['--listen-port', String(bridgePort), '--gateway-port', String(gatewayPort)],
      env: {
        TASKFERRY_SOCKET_PATH: daemon.socket,
        TASKFERRY_MCP_TOKEN: TOKEN,
        TASKFERRY_GATEWAY_TOKEN: GATEWAY_TOKEN,
        XDG_CONFIG_HOME: path.join(dir, 'config'),
      },
    });
    assert.equal(config.gateway?.port, gatewayPort);
    const surfaces = await startSurfaces(config);
    try {
      assert.ok(surfaces.gateway);
      assert.equal((surfaces.bridge.address() as net.AddressInfo).port, bridgePort);
      assert.equal((surfaces.gateway.address() as net.AddressInfo).port, gatewayPort);
    } finally {
      await surfaces.close();
    }
  } finally {
    await daemon.close();
    removeDir(dir);
  }
});

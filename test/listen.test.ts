import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createBridge } from '../src/server.ts';
import { listenBridge } from '../src/listen.ts';
import { HEALTH, call, removeDir, stubDaemon, tempDir, toolCall, okReply } from './helpers.ts';

// The URL only supplies the request path; the connection dials the unix socket.
// eslint-disable-next-line sonarjs/no-clear-text-protocols
const SOCKET_URL = 'http://tunnel.invalid/mcp';
const LISTEN_DIR = 'tf-listen-';

const config = (daemonSocket: string, listenPath: string) => ({
  daemonSocket,
  token: 'correct-secret',
  allowDirectories: [],
  allowModels: [],
  allowRoBinds: [],
  listen: { kind: 'unix' as const, path: listenPath },
});

test('the unix listener serves MCP on a socket only its owner can use', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const dir = tempDir(LISTEN_DIR);
  const listenPath = path.join(dir, 'run', 'mcp.sock');
  const server = createBridge(config(daemon.socket, listenPath));
  const listener = await listenBridge(server, { kind: 'unix', path: listenPath });
  try {
    assert.equal(statSync(listenPath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(listenPath)).mode & 0o777, 0o700);
    const res = await call(SOCKET_URL, toolCall(HEALTH), {
      socketPath: listenPath,
    });
    assert.notEqual(res.result?.isError, true);
    assert.equal(daemon.calls.length, 1);
  } finally {
    await listener.close();
    await daemon.close();
    removeDir(dir);
  }
});

test('an existing listen directory keeps its mode', async () => {
  const dir = tempDir(LISTEN_DIR);
  const shared = path.join(dir, 'shared');
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  const listenPath = path.join(shared, 'mcp.sock');
  const listener = await listenBridge(createBridge(config('/none', listenPath)), {
    kind: 'unix',
    path: listenPath,
  });
  try {
    assert.equal(statSync(shared).mode & 0o777, 0o755);
  } finally {
    await listener.close();
    removeDir(dir);
  }
});

test('stopping the listener removes its socket file', async () => {
  const dir = tempDir(LISTEN_DIR);
  const listenPath = path.join(dir, 'mcp.sock');
  const server = createBridge(config(path.join(dir, 'none.sock'), listenPath));
  const listener = await listenBridge(server, { kind: 'unix', path: listenPath });
  try {
    assert.equal(existsSync(listenPath), true);
    await listener.close();
    assert.equal(existsSync(listenPath), false);
  } finally {
    removeDir(dir);
  }
});

// Leaves a socket file behind the way a crashed instance does: a child binds it, then dies by SIGKILL.
const BIND_AND_WAIT = `
  const net = require('node:net');
  net.createServer().listen(process.argv[1], () => process.stdout.write('bound'));
  setInterval(() => {}, 1000);
`;
async function leaveStaleSocket(socketPath: string) {
  const child = spawn(process.execPath, ['-e', BIND_AND_WAIT, socketPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('a stale socket file left by a crash is replaced', async () => {
  const dir = tempDir(LISTEN_DIR);
  const listenPath = path.join(dir, 'mcp.sock');
  await leaveStaleSocket(listenPath);
  assert.equal(statSync(listenPath).isSocket(), true, 'the fixture must leave a stale socket');
  const listener = await listenBridge(createBridge(config('/none', listenPath)), {
    kind: 'unix',
    path: listenPath,
  });
  try {
    assert.equal(statSync(listenPath).isSocket(), true);
    assert.equal(statSync(listenPath).mode & 0o777, 0o600);
  } finally {
    await listener.close();
    removeDir(dir);
  }
});

test('a live instance already on the socket is never displaced', async () => {
  const dir = tempDir(LISTEN_DIR);
  const listenPath = path.join(dir, 'mcp.sock');
  const first = await listenBridge(createBridge(config('/none', listenPath)), {
    kind: 'unix',
    path: listenPath,
  });
  try {
    await assert.rejects(
      listenBridge(createBridge(config('/none', listenPath)), { kind: 'unix', path: listenPath }),
      /already in use/,
    );
    assert.equal(existsSync(listenPath), true, 'the running instance must keep its socket');
  } finally {
    await first.close();
    removeDir(dir);
  }
});

test('a regular file at the socket path is refused, not deleted', async () => {
  const dir = tempDir(LISTEN_DIR);
  const listenPath = path.join(dir, 'mcp.sock');
  writeFileSync(listenPath, 'precious');
  try {
    await assert.rejects(
      listenBridge(createBridge(config('/none', listenPath)), { kind: 'unix', path: listenPath }),
      /not a socket/,
    );
    assert.equal(existsSync(listenPath), true);
  } finally {
    removeDir(dir);
  }
});

test('the tcp listener binds loopback only', async () => {
  const server = createBridge({ ...config('/none', ''), listen: { kind: 'tcp', port: 0 } });
  const listener = await listenBridge(server, { kind: 'tcp', port: 0 });
  try {
    assert.equal((server.address() as net.AddressInfo).address, '127.0.0.1');
  } finally {
    await listener.close();
  }
});

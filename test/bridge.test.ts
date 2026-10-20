import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/server.ts';
import { createGateway } from '../src/gateway.ts';

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-mcp-'));
  const socket = path.join(dir, 'daemon.sock');
  const calls: any[] = [];
  const daemon = net.createServer((c) => {
    let buffer = '';
    c.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const n = buffer.indexOf('\n');
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        calls.push(req);
        const result = req.method === 'task.list' ? { tasks: [] } : { healthy: true };
        const payload = JSON.stringify({ version: 1, id: req.id, ok: true, result }) + '\n';
        c.write(payload.slice(0, 6));
        setImmediate(() => c.write(payload.slice(6)));
      }
    });
  });
  await new Promise<void>((r) => daemon.listen(socket, r));
  const bridge = createBridge({
    socketPath: socket,
    token: 'correct-secret',
    allowDirectories: [dir],
    allowModels: [],
  });
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
  const addr = bridge.address() as net.AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const close = async () => {
    await new Promise<void>((r) => bridge.close(() => r()));
    await new Promise<void>((r) => daemon.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { calls, url, close };
}
const rpc = (method: string, params: any = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
async function send(url: string, body: string, token = 'correct-secret') {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });
}

test('initialize, discovery and daemon mapping, including fragmented socket responses', async () => {
  const f = await fixture();
  try {
    const init = await (await send(f.url, rpc('initialize'))).json();
    assert.equal(init.result.serverInfo.name, 'taskferry-mcp');
    const tools = await (await send(f.url, rpc('tools/list'))).json();
    assert.equal(tools.result.tools.length, 5);
    const result = await (
      await send(f.url, rpc('tools/call', { name: 'taskferry_list', arguments: {} }))
    ).json();
    assert.deepEqual(JSON.parse(result.result.content[0].text), { tasks: [] });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'task.list');
  } finally {
    await f.close();
  }
});
test('unauthenticated requests never touch daemon, authenticated read succeeds', async () => {
  const f = await fixture();
  try {
    const fail = await send(
      f.url,
      rpc('tools/call', { name: 'taskferry_health', arguments: {} }),
      'wrong',
    );
    assert.equal(fail.status, 401);
    assert.equal(f.calls.length, 0);
    const ok = await send(f.url, rpc('tools/call', { name: 'taskferry_health', arguments: {} }));
    assert.equal(ok.status, 200);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
test('dispatch fails closed without configured allowlists', async () => {
  const f = await fixture();
  try {
    const res = await (
      await send(
        f.url,
        rpc('tools/call', {
          name: 'taskferry_dispatch',
          arguments: { directory: '/tmp', model: 'x', prompt: 'hi' },
        }),
      )
    ).json();
    assert.equal(res.result.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('rejects arbitrary daemon methods and invalid tool arguments', async () => {
  const f = await fixture();
  try {
    const unknown = await (
      await send(f.url, rpc('tools/call', { name: 'task.delete', arguments: {} }))
    ).json();
    assert.equal(unknown.result.isError, true);
    const bad = await (
      await send(
        f.url,
        rpc('tools/call', { name: 'taskferry_status', arguments: { taskId: '', override: true } }),
      )
    ).json();
    assert.equal(bad.result.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('gateway forwards protected requests but rejects unauthorized requests', async () => {
  const f = await fixture();
  const gateway = createGateway({
    upstreamUrl: f.url,
    inboundToken: 'gateway-secret',
    upstreamToken: 'correct-secret',
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  const addr = gateway.address() as net.AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  try {
    assert.equal(
      (await send(url, rpc('tools/call', { name: 'taskferry_health', arguments: {} }), 'wrong'))
        .status,
      401,
    );
    assert.equal(f.calls.length, 0);
    const result = await (
      await send(
        url,
        rpc('tools/call', { name: 'taskferry_health', arguments: {} }),
        'gateway-secret',
      )
    ).json();
    assert.equal(result.result.isError, undefined);
    assert.equal(f.calls.length, 1);
  } finally {
    await new Promise<void>((r) => gateway.close(() => r()));
    await f.close();
  }
});

test('cross-workspace status is denied and result content is never requested', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-scope-'));
  const socket = path.join(dir, 'daemon.sock');
  const calls: any[] = [];
  const daemon = net.createServer((c) => {
    let buf = '';
    c.on('data', (x) => {
      buf += x.toString();
      while (buf.includes('\n')) {
        const i = buf.indexOf('\n'),
          line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        calls.push(req);
        c.write(
          JSON.stringify({
            version: 1,
            id: req.id,
            ok: true,
            result:
              req.method === 'task.status'
                ? { id: req.params.taskId, directory: '/private/other-project', status: 'done' }
                : { message: 'SECRET' },
          }) + '\n',
        );
      }
    });
  });
  await new Promise<void>((r) => daemon.listen(socket, r));
  const bridge = createBridge({
    socketPath: socket,
    token: 'safe',
    allowDirectories: [dir],
    allowModels: [],
  });
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
  const addr = bridge.address() as net.AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  try {
    for (const name of ['taskferry_status', 'taskferry_result']) {
      const response = await (
        await send(url, rpc('tools/call', { name, arguments: { taskId: 'foreign-task' } }), 'safe')
      ).json();
      assert.equal(response.result.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /SECRET|private\/other-project/);
    }
    assert.deepEqual(
      calls.map((c) => c.method),
      ['task.status', 'task.status'],
    );
  } finally {
    await new Promise<void>((r) => bridge.close(() => r()));
    await new Promise<void>((r) => daemon.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

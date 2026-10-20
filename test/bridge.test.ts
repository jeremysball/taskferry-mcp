import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/server.ts';
import { createGateway } from '../src/gateway.ts';

const TOKEN = 'correct-secret';
const GATEWAY_TOKEN = 'gateway-secret';
const HEALTH = 'taskferry_health';
const STATUS_TOOL = 'taskferry_status';
const TASK_STATUS = 'task.status';

type Call = { id: string; method: string; params: Record<string, unknown> };
type Reply = {
  result: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    serverInfo?: { name: string };
    tools?: unknown[];
  };
};

const listenOnSocket = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve) => server.listen(socketPath, resolve));
const stop = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function serve(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

function writeChunks(c: net.Socket, out: string | Buffer[]) {
  if (typeof out === 'string') c.write(out);
  else out.forEach((part, i) => setTimeout(() => c.write(part), i * 20));
}

// A daemon that answers every request line with whatever `reply` returns: one write for a
// string, one delayed write per element for a list of chunks.
async function stubDaemon(reply: (req: Call) => string | Buffer[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-stub-'));
  const socket = path.join(dir, 'daemon.sock');
  const calls: Call[] = [];
  const server = net.createServer((c) => {
    let buffer = '';
    c.on('data', (chunk) => {
      buffer += chunk.toString();
      let n = buffer.indexOf('\n');
      while (n >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        n = buffer.indexOf('\n');
        if (!line) continue;
        const req: Call = JSON.parse(line);
        calls.push(req);
        writeChunks(c, reply(req));
      }
    });
  });
  await listenOnSocket(server, socket);
  const close = async () => {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, socket, calls, close };
}

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-mcp-'));
  const socket = path.join(dir, 'daemon.sock');
  const calls: Call[] = [];
  const daemon = net.createServer((c) => {
    let buffer = '';
    c.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const n = buffer.indexOf('\n');
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (!line) continue;
        const req: Call = JSON.parse(line);
        calls.push(req);
        const result = req.method === 'task.list' ? { tasks: [] } : { healthy: true };
        const payload = JSON.stringify({ version: 1, id: req.id, ok: true, result }) + '\n';
        c.write(payload.slice(0, 6));
        setImmediate(() => c.write(payload.slice(6)));
      }
    });
  });
  await listenOnSocket(daemon, socket);
  const bridge = createBridge({
    socketPath: socket,
    token: TOKEN,
    allowDirectories: [dir],
    allowModels: [],
  });
  const url = await serve(bridge);
  const close = async () => {
    await stop(bridge);
    await stop(daemon);
    rmSync(dir, { recursive: true, force: true });
  };
  return { calls, url, close };
}
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  rpc('tools/call', { name, arguments: args });
async function send(url: string, body: string, token = TOKEN) {
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
const json = async (res: Response) => (await res.json()) as Reply;

test('initialize, discovery and daemon mapping, including fragmented socket responses', async () => {
  const f = await fixture();
  try {
    const init = await json(await send(f.url, rpc('initialize')));
    assert.equal(init.result.serverInfo?.name, 'taskferry-mcp');
    const tools = await json(await send(f.url, rpc('tools/list')));
    assert.equal(tools.result.tools?.length, 5);
    const result = await json(await send(f.url, toolCall('taskferry_list')));
    assert.deepEqual(JSON.parse(result.result.content?.[0]?.text ?? ''), { tasks: [] });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.method, 'task.list');
  } finally {
    await f.close();
  }
});
test('unauthenticated requests never touch daemon, authenticated read succeeds', async () => {
  const f = await fixture();
  try {
    const fail = await send(f.url, toolCall(HEALTH), 'wrong');
    assert.equal(fail.status, 401);
    assert.equal(f.calls.length, 0);
    const ok = await send(f.url, toolCall(HEALTH));
    assert.equal(ok.status, 200);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
test('dispatch fails closed without configured allowlists', async () => {
  const f = await fixture();
  try {
    const res = await json(
      await send(
        f.url,
        toolCall('taskferry_dispatch', { directory: '/tmp', model: 'x', prompt: 'hi' }),
      ),
    );
    assert.equal(res.result.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('rejects arbitrary daemon methods and invalid tool arguments', async () => {
  const f = await fixture();
  try {
    const unknown = await json(await send(f.url, toolCall('task.delete')));
    assert.equal(unknown.result.isError, true);
    const bad = await json(
      await send(f.url, toolCall(STATUS_TOOL, { taskId: '', override: true })),
    );
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
    inboundToken: GATEWAY_TOKEN,
    upstreamToken: TOKEN,
  });
  const url = await serve(gateway);
  try {
    assert.equal((await send(url, toolCall(HEALTH), 'wrong')).status, 401);
    assert.equal(f.calls.length, 0);
    const result = await json(await send(url, toolCall(HEALTH), GATEWAY_TOKEN));
    assert.equal(result.result.isError, undefined);
    assert.equal(f.calls.length, 1);
  } finally {
    await stop(gateway);
    await f.close();
  }
});

test('cross-workspace status is denied and result content is never requested', async () => {
  const daemon = await stubDaemon(
    (req) =>
      JSON.stringify({
        version: 1,
        id: req.id,
        ok: true,
        result:
          req.method === TASK_STATUS
            ? { id: req.params.taskId, directory: '/private/other-project', status: 'done' }
            : { message: 'SECRET' },
      }) + '\n',
  );
  const bridge = createBridge({
    socketPath: daemon.socket,
    token: 'safe',
    allowDirectories: [daemon.dir],
    allowModels: [],
  });
  const url = await serve(bridge);
  try {
    for (const name of [STATUS_TOOL, 'taskferry_result']) {
      const response = await json(
        await send(url, toolCall(name, { taskId: 'foreign-task' }), 'safe'),
      );
      assert.equal(response.result.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /SECRET|private\/other-project/);
    }
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, TASK_STATUS],
    );
  } finally {
    await stop(bridge);
    await daemon.close();
  }
});

test('a non-object daemon reply becomes a tool error instead of crashing the bridge', async () => {
  const daemon = await stubDaemon(() => 'null\n');
  const bridge = createBridge({
    socketPath: daemon.socket,
    token: TOKEN,
    allowDirectories: [],
    allowModels: [],
  });
  const url = await serve(bridge);
  try {
    const res = await json(await send(url, toolCall(HEALTH)));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content?.[0]?.text ?? '', /invalid daemon reply/);
  } finally {
    await stop(bridge);
    await daemon.close();
  }
});

const daemonError = (id: string, code: string, message: string) =>
  JSON.stringify({
    version: 1,
    ok: false,
    error: { code, message, help: '', detail: message },
    id,
  }) + '\n';

test('an unknown task id is indistinguishable from an out-of-scope one', async () => {
  const daemon = await stubDaemon((req) =>
    daemonError(req.id, 'UNKNOWN_TASK', 'error: unknown task id: nope'),
  );
  const bridge = createBridge({
    socketPath: daemon.socket,
    token: TOKEN,
    allowDirectories: [daemon.dir],
    allowModels: [],
  });
  const url = await serve(bridge);
  try {
    for (const name of [STATUS_TOOL, 'taskferry_result']) {
      const res = await json(await send(url, toolCall(name, { taskId: 'nope' })));
      assert.equal(res.result.isError, true);
      assert.equal(res.result.content?.[0]?.text, 'task not accessible');
    }
  } finally {
    await stop(bridge);
    await daemon.close();
  }
});

test('other daemon failures still reach the caller, so an outage is not hidden', async () => {
  const daemon = await stubDaemon((req) =>
    daemonError(req.id, 'REQUEST_FAILED', 'daemon is on fire'),
  );
  const bridge = createBridge({
    socketPath: daemon.socket,
    token: TOKEN,
    allowDirectories: [daemon.dir],
    allowModels: [],
  });
  const url = await serve(bridge);
  try {
    const res = await json(await send(url, toolCall(STATUS_TOOL, { taskId: 'abc' })));
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content?.[0]?.text, 'daemon is on fire');
  } finally {
    await stop(bridge);
    await daemon.close();
  }
});

// Splits `payload` in the middle of its first two-byte character.
function splitInsideChar(payload: string) {
  const bytes = Buffer.from(payload);
  const at = bytes.indexOf(0xc3) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

test('a multibyte character split across daemon socket chunks survives', async () => {
  const daemon = await stubDaemon((req) =>
    splitInsideChar(
      JSON.stringify({ version: 1, id: req.id, ok: true, result: { text: '\u00e9' } }) + '\n',
    ),
  );
  const bridge = createBridge({
    socketPath: daemon.socket,
    token: TOKEN,
    allowDirectories: [],
    allowModels: [],
  });
  const url = await serve(bridge);
  try {
    const res = await json(await send(url, toolCall(HEALTH)));
    assert.deepEqual(JSON.parse(res.result.content?.[0]?.text ?? ''), { text: '\u00e9' });
  } finally {
    await stop(bridge);
    await daemon.close();
  }
});

// POSTs `parts` as separate writes with a pause between them; resolves to the parsed response.
function sendInParts(url: string, token: string, parts: Buffer[]) {
  return new Promise<{ id: string }>((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (out += d));
      res.on('end', () => resolve(JSON.parse(out)));
    });
    req.on('error', reject);
    parts.forEach((part, i) =>
      setTimeout(() => (i === parts.length - 1 ? req.end(part) : req.write(part)), i * 25),
    );
  });
}

test('a multibyte character split across request chunks survives, bridge and gateway', async () => {
  const f = await fixture();
  const gateway = createGateway({
    upstreamUrl: f.url,
    inboundToken: GATEWAY_TOKEN,
    upstreamToken: TOKEN,
  });
  const gatewayUrl = await serve(gateway);
  try {
    const body = splitInsideChar(JSON.stringify({ jsonrpc: '2.0', id: '\u00e9', method: 'ping' }));
    assert.equal((await sendInParts(f.url, TOKEN, body)).id, '\u00e9');
    assert.equal((await sendInParts(gatewayUrl, GATEWAY_TOKEN, body)).id, '\u00e9');
  } finally {
    await stop(gateway);
    await f.close();
  }
});

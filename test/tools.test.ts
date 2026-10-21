import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  HEALTH,
  STATUS_TOOL,
  TASK_STATUS,
  TOKEN,
  call,
  daemonError,
  fixture,
  okReply,
  rpc,
  splitInsideChar,
  startBridge,
  stubDaemon,
  toolCall,
} from './helpers.ts';

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'raw-test', version: '0.0.0' },
};

test('initialize, discovery and daemon mapping, including fragmented socket responses', async () => {
  const f = await fixture();
  try {
    const init = await call(f.url, rpc('initialize', INITIALIZE));
    assert.equal(init.result?.serverInfo?.name, 'taskferry-mcp');
    const tools = await call(f.url, rpc('tools/list'));
    assert.deepEqual(tools.result?.tools?.map((t) => t.name).sort(), [
      'taskferry_dispatch',
      'taskferry_health',
      'taskferry_list',
      'taskferry_result',
      'taskferry_status',
    ]);
    const result = await call(f.url, toolCall('taskferry_list'));
    assert.deepEqual(JSON.parse(result.result?.content?.[0]?.text ?? ''), { tasks: [] });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.method, 'task.list');
  } finally {
    await f.close();
  }
});

test('every tool schema is strict, and only dispatch is advertised as not read-only', async () => {
  const f = await fixture();
  try {
    const tools = (await call(f.url, rpc('tools/list'))).result?.tools ?? [];
    assert.equal(tools.length, 5);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts extra keys`);
      assert.equal(
        tool.annotations?.readOnlyHint,
        tool.name !== 'taskferry_dispatch',
        `${tool.name} readOnlyHint`,
      );
    }
  } finally {
    await f.close();
  }
});

test('the server does not claim it can push tool-list changes it has no session to send', async () => {
  const f = await fixture();
  try {
    const init = await call(f.url, rpc('initialize', INITIALIZE));
    assert.notEqual(init.result?.capabilities?.tools?.listChanged, true);
  } finally {
    await f.close();
  }
});

test('the official SDK client can connect, list tools and call one', async () => {
  const f = await fixture();
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 5);
    const result = await client.callTool({ name: HEALTH, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ healthy: true }) }]);
  } finally {
    await client.close();
    await f.close();
  }
});

test('dispatch fails closed without configured allowlists', async () => {
  const f = await fixture();
  try {
    const res = await call(
      f.url,
      toolCall('taskferry_dispatch', { directory: '/tmp', model: 'x', prompt: 'hi' }),
    );
    assert.equal(res.result?.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('dispatch needs both allowlists, and an allowed model alone is not enough', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: ['good'],
  });
  try {
    const args = { directory: daemon.dir, prompt: 'hi' };
    const denied = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { ...args, model: 'bad' }),
    );
    assert.equal(denied.result?.isError, true);
    assert.equal(daemon.calls.length, 0);
    const outside = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { ...args, directory: '/', model: 'good' }),
    );
    assert.equal(outside.result?.isError, true);
    assert.equal(daemon.calls.length, 0);
    const ok = await call(bridge.url, toolCall('taskferry_dispatch', { ...args, model: 'good' }));
    assert.notEqual(ok.result?.isError, true);
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      ['task.dispatch'],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('rejects arbitrary daemon methods and invalid tool arguments', async () => {
  const f = await fixture();
  try {
    const unknown = await call(f.url, toolCall('task.delete'));
    assert.ok(unknown.error ?? unknown.result?.isError, 'an unknown tool must be refused');
    const extraKey = await call(f.url, toolCall(STATUS_TOOL, { taskId: 'abc', override: true }));
    assert.equal(extraKey.result?.isError, true);
    const blank = await call(f.url, toolCall(STATUS_TOOL, { taskId: '   ' }));
    assert.equal(blank.result?.isError, true);
    const missing = await call(f.url, toolCall(STATUS_TOOL, {}));
    assert.equal(missing.result?.isError, true);
    const wrongType = await call(f.url, toolCall(STATUS_TOOL, { taskId: 7 }));
    assert.equal(wrongType.result?.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('cross-workspace status is denied and result content is never requested', async () => {
  const daemon = await stubDaemon((req) =>
    okReply(
      req,
      req.method === TASK_STATUS
        ? { id: req.params.taskId, directory: '/private/other-project', status: 'done' }
        : { message: 'SECRET' },
    ),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    for (const name of [STATUS_TOOL, 'taskferry_result']) {
      const response = await call(bridge.url, toolCall(name, { taskId: 'foreign-task' }));
      assert.equal(response.result?.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /SECRET|private\/other-project/);
    }
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, TASK_STATUS],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('an in-scope task reads through to its result', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(
      req,
      req.method === TASK_STATUS
        ? { id: req.params.taskId, directory: root, status: 'done' }
        : { message: 'DONE' },
    ),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(bridge.url, toolCall('taskferry_result', { taskId: 'mine' }));
    assert.notEqual(res.result?.isError, true);
    assert.deepEqual(JSON.parse(res.result?.content?.[0]?.text ?? ''), { message: 'DONE' });
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, 'task.result'],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('a non-object daemon reply becomes a tool error instead of crashing the bridge', async () => {
  const daemon = await stubDaemon(() => 'null\n');
  const bridge = await startBridge(daemon.socket);
  try {
    const res = await call(bridge.url, toolCall(HEALTH));
    assert.equal(res.result?.isError, true);
    assert.match(res.result?.content?.[0]?.text ?? '', /invalid daemon reply/);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('an unknown task id is indistinguishable from an out-of-scope one', async () => {
  const daemon = await stubDaemon((req) =>
    daemonError(req.id, 'UNKNOWN_TASK', 'error: unknown task id: nope'),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    for (const name of [STATUS_TOOL, 'taskferry_result']) {
      const res = await call(bridge.url, toolCall(name, { taskId: 'nope' }));
      assert.equal(res.result?.isError, true);
      assert.equal(res.result?.content?.[0]?.text, 'task not accessible');
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('other daemon failures still reach the caller, so an outage is not hidden', async () => {
  const daemon = await stubDaemon((req) =>
    daemonError(req.id, 'REQUEST_FAILED', 'daemon is on fire'),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(bridge.url, toolCall(STATUS_TOOL, { taskId: 'abc' }));
    assert.equal(res.result?.isError, true);
    assert.equal(res.result?.content?.[0]?.text, 'daemon is on fire');
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('a multibyte character split across daemon socket chunks survives', async () => {
  const daemon = await stubDaemon((req) => splitInsideChar(okReply(req, { text: 'é' })));
  const bridge = await startBridge(daemon.socket);
  try {
    const res = await call(bridge.url, toolCall(HEALTH));
    assert.deepEqual(JSON.parse(res.result?.content?.[0]?.text ?? ''), { text: 'é' });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

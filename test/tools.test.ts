import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  removeDir,
  rpc,
  splitInsideChar,
  startBridge,
  stubDaemon,
  tempDir,
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
    assert.match(init.result?.instructions ?? '', /taskferry_dispatch/);
    const tools = await call(f.url, rpc('tools/list'));
    assert.deepEqual(tools.result?.tools?.map((t) => t.name).sort(), [
      'taskferry_accept',
      'taskferry_cancel',
      'taskferry_dispatch',
      'taskferry_health',
      'taskferry_list',
      'taskferry_message',
      'taskferry_models',
      'taskferry_reject',
      'taskferry_result',
      'taskferry_resume',
      'taskferry_status',
      'taskferry_summary',
      'taskferry_worktree',
    ]);
    const result = await call(f.url, toolCall('taskferry_list'));
    assert.deepEqual(JSON.parse(result.result?.content?.[0]?.text ?? ''), {
      counts: { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: [],
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.method, 'task.list');
  } finally {
    await f.close();
  }
});

test('every tool schema is strict, and only the write tools are not read-only', async () => {
  const f = await fixture();
  try {
    const tools = (await call(f.url, rpc('tools/list'))).result?.tools ?? [];
    assert.equal(tools.length, 13);
    const writes = new Set([
      'taskferry_accept',
      'taskferry_cancel',
      'taskferry_dispatch',
      'taskferry_reject',
      'taskferry_resume',
      'taskferry_summary',
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts extra keys`);
      assert.equal(
        tool.annotations?.readOnlyHint,
        !writes.has(tool.name),
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
    assert.equal((await client.listTools()).tools.length, 13);
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

test('models lists allowed ids, marks missing entries, and searches the catalog', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const model = 'good';
  const missing = 'missing/model';
  const bridge = await startBridge(
    daemon.socket,
    { allowModels: [model, missing] },
    { listModels: async () => [model, 'other/model', 'wild/model'] },
  );
  try {
    const allowed = await call(bridge.url, toolCall('taskferry_models', {}));
    const body = JSON.parse(allowed.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(body.allowedModels, [model, missing]);
    assert.deepEqual(body.missingAllowedModels, [missing]);
    assert.deepEqual(body.models, [{ id: model, allowed: true }]);
    assert.equal(body.totalInstalledModels, 3);

    const searched = await call(bridge.url, toolCall('taskferry_models', { query: 'wild' }));
    const match = JSON.parse(searched.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(match.models, [{ id: 'wild/model', allowed: false }]);
    assert.equal(match.matched, 1);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('dispatch names the denied side and forwards the reasoning variant', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: ['good'],
  });
  try {
    const badModel = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        model: 'bad',
        prompt: 'hi',
      }),
    );
    const modelError = badModel.result?.content?.[0]?.text ?? '';
    assert.match(modelError, /model denied: bad/);
    assert.match(modelError, /allowed models: good/);

    const badDirectory = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: '/', model: 'good', prompt: 'hi' }),
    );
    assert.match(badDirectory.result?.content?.[0]?.text ?? '', /workspace denied:/);

    const ok = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        model: 'good',
        prompt: 'hi',
        variant: 'high',
      }),
    );
    assert.notEqual(ok.result?.isError, true);
    assert.equal(daemon.calls[0]?.params.variant, 'high');
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('read-only binds are allowlisted, resolved and forwarded only when requested', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const allowedDir = tempDir('tf-ro-bind-');
  const outsideDir = tempDir('tf-ro-bind-outside-');
  const allowedFile = path.join(allowedDir, 'auth.json');
  const outsideFile = path.join(outsideDir, 'secret');
  const missing = path.join(allowedDir, 'missing');
  const link = path.join(allowedDir, 'link');
  const subDir = path.join(allowedDir, 'sub');
  const settings = path.join(subDir, 'settings.json');
  mkdirSync(subDir);
  const emptyJson = '{}';
  writeFileSync(allowedFile, emptyJson);
  writeFileSync(outsideFile, 'secret');
  writeFileSync(settings, emptyJson);
  symlinkSync(outsideFile, link);
  const realAllowedFile = realpathSync(allowedFile);
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    allowRoBinds: [allowedFile, subDir],
  });
  const dispatch = (roBind: string[]) =>
    call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        prompt: 'hi',
        roBind,
        model,
      }),
    );
  try {
    for (const denied of [outsideFile, link, missing, 'relative/path']) {
      const res = await dispatch([denied]);
      assert.equal(res.result?.isError, true, `${denied} must be refused`);
    }
    assert.equal(daemon.calls.length, 0);

    const allowed = await dispatch([allowedFile, settings]);
    assert.notEqual(allowed.result?.isError, true);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params.roBind, [realAllowedFile, realpathSync(settings)]);

    const withoutBind = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(withoutBind.result?.isError, true);
    assert.equal(daemon.calls[1]?.params.roBind, undefined);
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(allowedDir);
    removeDir(outsideDir);
  }
});

test('a read-only bind is refused when the bind allowlist is empty', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'auth.json');
  writeFileSync(file, '{}');
  try {
    const res = await call(
      f.url,
      toolCall('taskferry_dispatch', {
        directory: f.dir,
        model: 'good',
        prompt: 'hi',
        roBind: [file],
      }),
    );
    assert.equal(res.result?.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
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
    const badField = await call(
      f.url,
      toolCall('taskferry_result', { taskId: 'abc', fields: ['secret'] }),
    );
    assert.equal(badField.result?.isError, true);
    const shortSummary = await call(
      f.url,
      toolCall('taskferry_summary', { taskId: 'abc', maxWords: 74 }),
    );
    assert.equal(shortSummary.result?.isError, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('cross-workspace status, result and summary are denied before content is requested', async () => {
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
    for (const name of [STATUS_TOOL, 'taskferry_result', 'taskferry_summary']) {
      const response = await call(bridge.url, toolCall(name, { taskId: 'foreign-task' }));
      assert.equal(response.result?.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /SECRET|private\/other-project/);
    }
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, TASK_STATUS, TASK_STATUS],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('list without a directory shows only rows inside allowed workspaces', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      counts: { queued: 0, running: 0, done: 2, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: [
        { id: 'inside', status: 'done', directory: root },
        { id: 'outside', status: 'done', directory: '/private/other-project' },
      ],
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(bridge.url, toolCall('taskferry_list'));
    assert.notEqual(res.result?.isError, true);
    const body = JSON.parse(res.result?.content?.[0]?.text ?? '');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['inside'],
    );
    assert.equal(body.counts.done, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
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

test('result forwards field projection and full narration', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(
      req,
      req.method === TASK_STATUS
        ? { id: req.params.taskId, directory: root, status: 'done' }
        : { message: 'DONE', tokens: 12 },
    ),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_result', {
        taskId: 'mine',
        full: true,
        fields: ['narration', 'tokens'],
      }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.deepEqual(daemon.calls[1]?.params, {
      taskId: 'mine',
      full: true,
      fields: ['narration', 'tokens'],
    });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('summary is scoped and forwards its mode and word budget', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(
      req,
      req.method === TASK_STATUS
        ? { id: req.params.taskId, directory: root, status: 'done' }
        : { summaryTask: { id: 'summary-1', status: 'queued' } },
    ),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_summary', { taskId: 'mine', mode: 'activity', maxWords: 75 }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, 'task.summary'],
    );
    assert.deepEqual(daemon.calls[1]?.params, {
      taskId: 'mine',
      mode: 'activity',
      maxWords: 75,
    });
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
    for (const name of [STATUS_TOOL, 'taskferry_result', 'taskferry_summary']) {
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

test('malformed task lists fail closed', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { tasks: 'invalid' }));
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content?.[0]?.text ?? '', /task.list.*tasks.*array/);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('multiple workspace lists query roots independently and deduplicate visible rows', async () => {
  const second = tempDir('tf-second-');
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks:
        req.params.directory === second
          ? [
              { id: 'visible', directory: second, status: 'done' },
              { id: 'visible', directory: second, status: 'done' },
            ]
          : Array.from({ length: 500 }, (_, i) => ({
              id: `foreign-${i}`,
              directory: '/private/foreign',
              status: 'done',
            })),
    }),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir, second] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((row: { id: string }) => row.id),
      ['visible'],
    );
    assert.equal(body.counts.done, 1);
    assert.match(body.note, /cap reached/);
    assert.deepEqual(
      daemon.calls.map((req) => req.params),
      [{ directory: daemon.dir }, { directory: second }],
    );
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
  }
});

test('full result requires an explicit narration projection', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => okReply(req, { directory: root, status: 'done' }));
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    for (const fields of [undefined, ['message']]) {
      const response = await call(
        bridge.url,
        toolCall('taskferry_result', { taskId: 'mine', full: true, ...(fields ? { fields } : {}) }),
      );
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? '', /full.*narration/);
    }
    assert.equal(daemon.calls.length, 0);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('visible listing resolves allowed roots once rather than once per row', async (t) => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        directory: path.join(root, 'child'),
        status: 'done',
      })),
    }),
  );
  root = daemon.dir;
  mkdirSync(path.join(root, 'child'));
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  const original = fsPromises.realpath;
  let rootResolutions = 0;
  t.mock.method(fsPromises, 'realpath', async (value: string) => {
    if (value === root) rootResolutions++;
    return original(value);
  });
  syncBuiltinESMExports();
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.equal(body.tasks.length, 10);
    assert.equal(rootResolutions, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await bridge.close();
    await daemon.close();
  }
});

test('merged lists retain newest-first ordering and apply a total cap after deduplication', async () => {
  const second = tempDir('tf-list-cap-');
  let root = '';
  const daemon = await stubDaemon((req) => {
    const directory = req.params.directory === second ? second : root;
    const start = directory === second ? 300 : 0;
    return okReply(req, {
      tasks: Array.from({ length: 300 }, (_, i) => ({
        directory,
        id: `task-${start + i}`,
        status: 'done',
        startedAt: new Date((start + i) * 1000).toISOString(),
      })),
    });
  });
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root, second] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.equal(body.tasks.length, 500);
    assert.equal(body.counts.done, 500);
    assert.equal(body.tasks[0].id, 'task-599');
    assert.equal(body.tasks[499].id, 'task-100');
    assert.match(body.note, /cap reached/);
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
  }
});

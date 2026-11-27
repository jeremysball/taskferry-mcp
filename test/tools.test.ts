import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

const WORKER_BINDS = ['skills/searching-the-web', 'skills/using-chhoto'];
const CONTROLLER_BINDS = ['skills', 'fleet-skills', 'plugins/cache'];
const SUMMARY_METHOD = 'task.summary';
const TASK_RESULT_METHOD = 'task.result';
const TOOLS_LIST = 'tools/list';
const bindsUnder = (root: string, relative: readonly string[]) =>
  relative.map((entry) => path.join(root, entry));

test('initialize, discovery and daemon mapping, including fragmented socket responses', async () => {
  const f = await fixture();
  try {
    const init = await call(f.url, rpc('initialize', INITIALIZE));
    assert.equal(init.result?.serverInfo?.name, 'taskferry-mcp');
    assert.match(init.result?.instructions ?? '', /taskferry_dispatch/);
    assert.match(init.result?.instructions ?? '', /historical tasks fleet-wide/);
    assert.match(init.result?.instructions ?? '', /dispatch directory was deleted/);
    assert.doesNotMatch(init.result?.instructions ?? '', /only see tasks whose directory/);
    const tools = await call(f.url, rpc(TOOLS_LIST));
    assert.deepEqual(tools.result?.tools?.map((t) => t.name).sort(), [
      'taskferry_accept',
      'taskferry_cancel',
      'taskferry_dispatch',
      'taskferry_files',
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

test('dispatch advertises narrow directory scope in the tool and directory descriptions', async () => {
  const f = await fixture();
  try {
    const tools = (await call(f.url, rpc(TOOLS_LIST))).result?.tools ?? [];
    const dispatch = tools.find((tool) => tool.name === 'taskferry_dispatch') as
      | {
          description?: string;
          inputSchema: { properties: { directory?: { description?: string } } };
        }
      | undefined;
    assert.ok(dispatch);
    const directory = dispatch.inputSchema.properties.directory?.description ?? '';
    for (const description of [dispatch.description ?? '', directory]) {
      assert.match(description, /smallest.*existing.*allowed.*writable/i);
      assert.match(description, /project\/worktree/i);
      assert.match(description, /scratch/i);
      assert.match(description, /home.*\/workspace.*filesystem root.*broad parent/i);
      assert.match(
        description,
        /when a copy-on-write overlay is enabled, the directory sets its writable scope and the changeset\/diff scope/i,
      );
    }
    assert.match(dispatch.description ?? '', /controller.*child/i);
    assert.match(dispatch.description ?? '', /read-only.*mask.*allowlist/i);
    assert.match(dispatch.description ?? '', /do not disable.*sandbox/i);
  } finally {
    await f.close();
  }
});

test('every tool schema is strict, and only the write tools are not read-only', async () => {
  const f = await fixture();
  try {
    const tools = (await call(f.url, rpc(TOOLS_LIST))).result?.tools ?? [];
    assert.equal(tools.length, 14);
    const writes = new Set([
      'taskferry_accept',
      'taskferry_cancel',
      'taskferry_dispatch',
      'taskferry_reject',
      'taskferry_resume',
      'taskferry_summary',
    ]);
    const destructive = new Set([
      'taskferry_accept',
      'taskferry_cancel',
      'taskferry_dispatch',
      'taskferry_reject',
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} accepts extra keys`);
      assert.equal(
        tool.annotations?.readOnlyHint,
        !writes.has(tool.name),
        `${tool.name} readOnlyHint`,
      );
      assert.equal(
        tool.annotations?.destructiveHint === true,
        destructive.has(tool.name),
        `${tool.name} destructiveHint`,
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
    assert.equal((await client.listTools()).tools.length, 14);
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

test('dispatch forwards every explicit executor and a provider/model id unchanged', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'llmgateway/glm-5.3-flash';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  try {
    for (const executor of ['opencode', 'pi', 'kilo']) {
      const res = await call(
        bridge.url,
        toolCall('taskferry_dispatch', {
          directory: daemon.dir,
          prompt: 'hi',
          executor,
          model,
        }),
      );
      assert.notEqual(res.result?.isError, true, executor);
      assert.deepEqual(daemon.calls.at(-1)?.params, {
        directory: daemon.dir,
        prompt: 'hi',
        executor,
        model,
      });
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('dispatch omits the executor key when the argument is omitted', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.equal(daemon.calls.length, 1);
    const params = daemon.calls[0]?.params ?? {};
    assert.equal(Object.hasOwn(params, 'executor'), false);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('dispatch rejects invalid executor values before calling the daemon', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  try {
    for (const executor of ['claude', 'Kilo', '']) {
      const res = await call(
        bridge.url,
        toolCall('taskferry_dispatch', {
          directory: daemon.dir,
          prompt: 'hi',
          executor,
          model,
        }),
      );
      assert.equal(res.result?.isError, true, JSON.stringify(executor));
    }
    assert.equal(daemon.calls.length, 0);
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
    assert.deepEqual(daemon.calls[0]?.params.roBind, [
      ...bindsUnder(bridge.skillRoot, WORKER_BINDS),
      realAllowedFile,
      realpathSync(settings),
    ]);

    const withoutBind = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(withoutBind.result?.isError, true);
    assert.deepEqual(daemon.calls[1]?.params.roBind, bindsUnder(bridge.skillRoot, WORKER_BINDS));
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(allowedDir);
    removeDir(outsideDir);
  }
});

test('the controller skill profile mounts every skill root', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'controller',
  });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.deepEqual(
      daemon.calls[0]?.params.roBind,
      bindsUnder(bridge.skillRoot, CONTROLLER_BINDS),
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('the none profile mounts no skill paths and omits roBind', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.equal(daemon.calls[0]?.params.roBind, undefined);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('profile and server binds skip an empty caller allowlist', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const bindDir = tempDir('tf-server-bind-');
  const serverBind = path.join(bindDir, 'settings.json');
  writeFileSync(serverBind, '{}');
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    serverRoBinds: [serverBind],
  });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.notEqual(res.result?.isError, true);
    assert.deepEqual(daemon.calls[0]?.params.roBind, [
      ...bindsUnder(bridge.skillRoot, WORKER_BINDS),
      realpathSync(serverBind),
    ]);
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(bindDir);
  }
});

test('a missing server bind fails the dispatch instead of mounting less', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const skillRoot = tempDir('tf-skills-partial-');
  mkdirSync(path.join(skillRoot, WORKER_BINDS[0]), { recursive: true });
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillRoot,
  });
  try {
    const res = await call(
      bridge.url,
      toolCall('taskferry_dispatch', { directory: daemon.dir, prompt: 'hi', model }),
    );
    assert.equal(res.result?.isError, true);
    assert.match(res.result?.content?.[0]?.text ?? '', /server bind unavailable/);
    assert.equal(daemon.calls.length, 0);
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(skillRoot);
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

test('cross-workspace status and result read history while summary stays scoped', async () => {
  const foreign = tempDir('tf-foreign-workspace-');
  const foreignTask = 'foreign-task';
  const daemon = await stubDaemon((req) =>
    okReply(
      req,
      req.method === TASK_STATUS
        ? { id: req.params.taskId, directory: foreign, status: 'done' }
        : { message: 'SECRET' },
    ),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const status = await call(bridge.url, toolCall(STATUS_TOOL, { taskId: foreignTask }));
    assert.notEqual(status.result?.isError, true);
    assert.equal(JSON.parse(status.result?.content?.[0]?.text ?? '{}').directory, foreign);

    const result = await call(bridge.url, toolCall('taskferry_result', { taskId: foreignTask }));
    assert.notEqual(result.result?.isError, true);
    assert.equal(JSON.parse(result.result?.content?.[0]?.text ?? '{}').message, 'SECRET');

    const summary = await call(bridge.url, toolCall('taskferry_summary', { taskId: foreignTask }));
    assert.equal(summary.result?.isError, true);
    const text = summary.result?.content?.[0]?.text ?? '';
    assert.ok(!text.includes('SECRET'));
    assert.ok(!text.includes(foreign));

    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, TASK_STATUS, TASK_RESULT_METHOD, TASK_STATUS],
    );
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(foreign);
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
      [TASK_STATUS, TASK_RESULT_METHOD],
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
      [TASK_STATUS, SUMMARY_METHOD],
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

test('task.summary gets the summary budget while ordinary calls keep the daemon timeout', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => {
    let result: unknown;
    if (req.method === TASK_STATUS) {
      result = { id: req.params.taskId, directory: root, status: 'done' };
    } else if (req.method === SUMMARY_METHOD) {
      result = { summaryTask: { id: 'summary-1', status: 'queued' } };
    } else {
      result = { message: 'DONE' };
    }
    const payload = okReply(req, result);
    if (req.method !== SUMMARY_METHOD && req.method !== TASK_RESULT_METHOD) return payload;
    // Hold the reply head open for 300 ms without writing bytes: past the
    // ordinary 100 ms daemon budget but under the 1 s summary budget.
    return [payload.slice(0, 1), ...Array(300).fill(''), payload.slice(1)];
  });
  root = daemon.dir;
  try {
    const bridge = await startBridge(daemon.socket, {
      allowDirectories: [daemon.dir],
      daemonTimeoutMs: 100,
      summaryTimeoutMs: 1000,
    });
    try {
      const summary = await call(bridge.url, toolCall('taskferry_summary', { taskId: 'mine' }));
      assert.notEqual(summary.result?.isError, true);
      assert.deepEqual(JSON.parse(summary.result?.content?.[0]?.text ?? '{}'), {
        summaryTask: { id: 'summary-1', status: 'queued' },
      });

      const result = await call(bridge.url, toolCall('taskferry_result', { taskId: 'mine' }));
      assert.equal(result.result?.isError, true);
      assert.match(result.result?.content?.[0]?.text ?? '', /daemon timeout/);
    } finally {
      await bridge.close();
    }

    // A summary budget below the delay must time out, proving the handler
    // reads the configured knob instead of a hardcoded 60 s default.
    const strict = await startBridge(daemon.socket, {
      allowDirectories: [daemon.dir],
      daemonTimeoutMs: 1000,
      summaryTimeoutMs: 100,
    });
    try {
      const summary = await call(strict.url, toolCall('taskferry_summary', { taskId: 'mine' }));
      assert.equal(summary.result?.isError, true);
      assert.match(summary.result?.content?.[0]?.text ?? '', /daemon timeout/);
    } finally {
      await strict.close();
    }
  } finally {
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

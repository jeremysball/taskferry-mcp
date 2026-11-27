import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Call,
  call,
  daemonError,
  okReply,
  removeDir,
  send,
  startBridge,
  stubDaemon,
  tempDir,
  toolCall,
} from './helpers.ts';

const TASK_STATUS = 'task.status';
const TASK_ID = 'task-1';
const MESSAGE = 'historical message';
const READABLE = 'still readable';
const DONE = 'done';
const MODEL = 'allowed/model';
const FOREIGN_DIR = '/private/other-project';
const DELETED_DIR = path.join(tmpdir(), 'tf-deleted-historical-workspace');

const statusReply = (req: Call, directory: string) =>
  okReply(req, { directory, id: req.params.taskId, status: DONE, model: MODEL });

test('status, result and message read tasks outside the allowlist and in deleted directories', async () => {
  for (const directory of [FOREIGN_DIR, DELETED_DIR]) {
    const daemon = await stubDaemon((req) =>
      req.method === TASK_STATUS ? statusReply(req, directory) : okReply(req, { message: MESSAGE }),
    );
    const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
    try {
      const status = await call(bridge.url, toolCall('taskferry_status', { taskId: TASK_ID }));
      assert.notEqual(status.result?.isError, true);
      assert.equal(JSON.parse(status.result?.content?.[0]?.text ?? '{}').directory, directory);

      const result = await call(bridge.url, toolCall('taskferry_result', { taskId: TASK_ID }));
      assert.notEqual(result.result?.isError, true);
      assert.equal(JSON.parse(result.result?.content?.[0]?.text ?? '{}').message, MESSAGE);

      const message = await call(
        bridge.url,
        toolCall('taskferry_message', { taskId: TASK_ID, confirm: true }),
      );
      assert.notEqual(message.result?.isError, true);
      const body = JSON.parse(message.result?.content?.[0]?.text ?? '{}');
      assert.equal(body.status, DONE);
      assert.equal(body.message, MESSAGE);
    } finally {
      await bridge.close();
      await daemon.close();
    }
  }
});

test('historical reads work with an empty workspace allowlist', async () => {
  const daemon = await stubDaemon((req) =>
    req.method === TASK_STATUS
      ? statusReply(req, DELETED_DIR)
      : okReply(req, { message: READABLE }),
  );
  const bridge = await startBridge(daemon.socket);
  try {
    for (const [name, args, check] of [
      ['taskferry_status', {}, (body: { directory?: string }) => body.directory === DELETED_DIR],
      ['taskferry_result', {}, (body: { message?: string }) => body.message === READABLE],
      [
        'taskferry_message',
        { confirm: true },
        (body: { message?: string }) => body.message === READABLE,
      ],
    ] as const) {
      const response = await call(bridge.url, toolCall(name, { taskId: TASK_ID, ...args }));
      assert.notEqual(response.result?.isError, true, name);
      assert.equal(check(JSON.parse(response.result?.content?.[0]?.text ?? '{}')), true, name);
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('a genuine unknown task id stays indistinguishable from an inaccessible one', async () => {
  const daemon = await stubDaemon((req) =>
    daemonError(req.id, 'UNKNOWN_TASK', 'error: unknown task id: nope'),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    for (const name of ['taskferry_status', 'taskferry_result', 'taskferry_message']) {
      const response = await call(bridge.url, toolCall(name, { taskId: 'nope' }));
      assert.equal(response.result?.isError, true, name);
      assert.equal(response.result?.content?.[0]?.text, 'task not accessible', name);
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('authentication is still required for fleet-wide historical reads', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { tasks: [] }));
  const bridge = await startBridge(daemon.socket);
  try {
    for (const name of [
      'taskferry_list',
      'taskferry_status',
      'taskferry_result',
      'taskferry_message',
    ]) {
      const response = await send(bridge.url, toolCall(name, { taskId: TASK_ID }), {
        token: null,
      });
      assert.equal(response.status, 401, name);
    }
    assert.equal(daemon.calls.length, 0);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('dispatch, resume, summary and mutations still reject out-of-scope tasks', async () => {
  const outside = tempDir('tf-history-outside-');
  const daemon = await stubDaemon((req) => {
    if (req.method === TASK_STATUS) return statusReply(req, FOREIGN_DIR);
    return okReply(req, { ok: true });
  });
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
  });
  try {
    const dispatch = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: outside,
        model: MODEL,
        prompt: 'hi',
      }),
    );
    assert.equal(dispatch.result?.isError, true);
    assert.match(dispatch.result?.content?.[0]?.text ?? '', /workspace denied:/);

    for (const [name, args] of [
      ['taskferry_resume', { prompt: 'hi' }],
      ['taskferry_summary', {}],
      ['taskferry_accept', {}],
      ['taskferry_reject', {}],
      ['taskferry_cancel', {}],
    ] as const) {
      const response = await call(bridge.url, toolCall(name, { taskId: 'foreign', ...args }));
      assert.equal(response.result?.isError, true, name);
      assert.equal(response.result?.content?.[0]?.text, 'task not accessible', name);
    }
    assert.equal(
      daemon.calls.some((entry) =>
        ['task.dispatch', 'task.summary', 'task.accept', 'task.reject', 'task.cancel'].includes(
          entry.method,
        ),
      ),
      false,
      'no queueing or mutation may reach the daemon for an out-of-scope task',
    );
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(outside);
  }
});

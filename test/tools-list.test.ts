import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { call, okReply, removeDir, startBridge, stubDaemon, tempDir, toolCall } from './helpers.ts';

const FOREIGN_PREFIX = 'tf-list-foreign-';

test('list without a directory returns every recorded task, including deleted and outside workspaces', async () => {
  const foreign = tempDir(FOREIGN_PREFIX);
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      counts: { queued: 0, running: 0, done: 4, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: [
        { id: 'inside', status: 'done', directory: root },
        { id: 'deleted-nested', status: 'done', directory: `${root}/removed-child` },
        { id: 'deleted-sibling', status: 'done', directory: `${root}-removed-sibling` },
        { id: 'outside', status: 'done', directory: foreign },
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
      ['inside', 'deleted-nested', 'deleted-sibling', 'outside'],
    );
    assert.equal(body.counts.done, 4);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(foreign);
  }
});

test('list all: true is the explicit fleet-wide request and cannot combine with directory', async () => {
  const foreign = tempDir(FOREIGN_PREFIX);
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [
        { id: 'inside', status: 'done', directory: root },
        { id: 'outside', status: 'done', directory: foreign },
      ],
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { all: true }));
    assert.notEqual(response.result?.isError, true);
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['inside', 'outside'],
    );
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});

    const combined = await call(
      bridge.url,
      toolCall('taskferry_list', { all: true, directory: root }),
    );
    assert.equal(combined.result?.isError, true);
    assert.match(
      combined.result?.content?.[0]?.text ?? '',
      /all cannot be combined with directory/,
    );
    assert.equal(daemon.calls.length, 1, 'a combined request must not reach the daemon');
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(foreign);
  }
});

test('historical listing does not require a workspace allowlist', async () => {
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [{ id: 'any', status: 'done', directory: '/some/deleted-workspace' }],
    }),
  );
  const bridge = await startBridge(daemon.socket);
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    assert.notEqual(response.result?.isError, true);
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['any'],
    );
    assert.equal(daemon.calls.length, 1);
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

test('an empty all-workspaces task list sentinel becomes an empty array', async () => {
  const counts = { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 };
  const daemon = await stubDaemon((req) =>
    okReply(req, { counts, tasks: "none found (this server process's lifetime)" }),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    assert.notEqual(response.result?.isError, true);
    assert.deepEqual(JSON.parse(response.result?.content?.[0]?.text ?? ''), {
      counts,
      tasks: [],
    });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('an empty scoped task list sentinel becomes an empty array', async () => {
  const counts = { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 };
  const daemon = await stubDaemon((req) =>
    okReply(req, { counts, tasks: 'none found in this workspace' }),
  );
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { directory: daemon.dir }));
    assert.notEqual(response.result?.isError, true);
    assert.deepEqual(JSON.parse(response.result?.content?.[0]?.text ?? ''), {
      counts,
      tasks: [],
    });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('an existing directory outside the allowlist is a list filter, not a denial', async () => {
  const outside = tempDir('tf-list-outside-');
  const daemon = await stubDaemon((req) => okReply(req, { counts: {}, tasks: [] }));
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { directory: outside }));
    assert.notEqual(response.result?.isError, true);
    assert.deepEqual(daemon.calls[0]?.params, { directory: realpathSync(outside) });
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(outside);
  }
});

test('a deleted absolute directory filters the all-task rows by exact path', async () => {
  let root = '';
  const deleted = () => `${root}/removed-child`;
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [
        { id: 'exact', status: 'done', directory: deleted() },
        { id: 'nested', status: 'done', directory: `${deleted()}/nested` },
        { id: 'sibling-prefix', status: 'done', directory: `${deleted()}-sibling` },
        { id: 'inside', status: 'done', directory: root },
      ],
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { directory: deleted() }));
    assert.notEqual(response.result?.isError, true);
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['exact'],
    );
    assert.equal(body.counts.done, 1);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('a deleted directory filter reports the daemon row cap when the all-task reply was capped', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: Array.from({ length: 500 }, (_, i) => ({
        id: `task-${i}`,
        status: 'done',
        directory: i === 0 ? `${root}/removed` : root,
      })),
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    const response = await call(
      bridge.url,
      toolCall('taskferry_list', { directory: `${root}/removed` }),
    );
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['task-0'],
    );
    assert.match(body.note, /cap reached/);
  } finally {
    await bridge.close();
    await daemon.close();
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

test('one all-tasks response keeps the daemon order and applies a total cap', async () => {
  const second = tempDir('tf-list-cap-');
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      counts: { queued: 0, running: 0, done: 600, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: Array.from({ length: 600 }, (_, i) => ({
        directory: i % 2 === 0 ? root : second,
        id: `task-${i}`,
        status: 'done',
        startedAt: new Date((i + 1) * 1000).toISOString(),
      })),
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root, second] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.equal(body.tasks.length, 500);
    assert.equal(body.counts.done, 600, 'the daemon all-time tally is preserved');
    assert.equal(body.tasks[0].id, 'task-0');
    assert.equal(body.tasks[499].id, 'task-499');
    assert.match(body.note, /cap reached/);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
  }
});

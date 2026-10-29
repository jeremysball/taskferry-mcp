import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { call, okReply, removeDir, startBridge, stubDaemon, tempDir, toolCall } from './helpers.ts';

const FOREIGN_PREFIX = 'tf-list-foreign-';

test('list without a directory shows only rows inside allowed workspaces', async () => {
  const foreign = tempDir(FOREIGN_PREFIX);
  let root = '';
  let sibling = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      counts: { queued: 0, running: 0, done: 3, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: [
        { id: 'inside', status: 'done', directory: root },
        { id: 'nested', status: 'done', directory: `${root}/child` },
        { id: 'sibling-prefix', status: 'done', directory: sibling },
        { id: 'outside', status: 'done', directory: foreign },
      ],
    }),
  );
  root = daemon.dir;
  sibling = `${root}-sibling`;
  mkdirSync(`${root}/child`);
  mkdirSync(sibling);
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    const res = await call(bridge.url, toolCall('taskferry_list'));
    assert.notEqual(res.result?.isError, true);
    const body = JSON.parse(res.result?.content?.[0]?.text ?? '');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['inside', 'nested'],
    );
    assert.equal(body.counts.done, 2);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(foreign);
    removeDir(sibling);
  }
});

test('list all: true is an explicit fleet-wide request and cannot combine with directory', async () => {
  const second = tempDir('tf-list-second-');
  const foreign = tempDir(FOREIGN_PREFIX);
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [
        { id: 'inside', status: 'done', directory: root },
        { id: 'second-root', status: 'done', directory: second },
        { id: 'outside', status: 'done', directory: foreign },
      ],
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root, second] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { all: true }));
    assert.notEqual(response.result?.isError, true);
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((task: { id: string }) => task.id),
      ['inside', 'second-root'],
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
    removeDir(second);
    removeDir(foreign);
  }
});

test('list all: true still fails closed without a workspace allowlist', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { tasks: [] }));
  const bridge = await startBridge(daemon.socket);
  try {
    const response = await call(bridge.url, toolCall('taskferry_list', { all: true }));
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content?.[0]?.text ?? '', /workspace allowlist required/);
    assert.equal(daemon.calls.length, 0);
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

test('a multi-root list uses one all-tasks request and filters every root', async () => {
  const second = tempDir('tf-second-');
  const foreign = tempDir(FOREIGN_PREFIX);
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [
        { id: 'root-row', directory: root, status: 'done' },
        { id: 'nested-row', directory: `${root}/nested`, status: 'done' },
        { id: 'second-row', directory: second, status: 'done' },
        { id: 'foreign-row', directory: foreign, status: 'done' },
      ],
    }),
  );
  root = daemon.dir;
  mkdirSync(`${root}/nested`);
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root, second] });
  try {
    const response = await call(bridge.url, toolCall('taskferry_list'));
    assert.notEqual(response.result?.isError, true);
    const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      body.tasks.map((row: { id: string }) => row.id),
      ['root-row', 'nested-row', 'second-row'],
    );
    assert.equal(body.counts.done, 3);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
    removeDir(foreign);
  }
});

test('one all-tasks response deduplicates visible rows and reports the daemon row cap', async () => {
  const second = tempDir('tf-second-');
  const foreign = tempDir(FOREIGN_PREFIX);
  const daemon = await stubDaemon((req) =>
    okReply(req, {
      tasks: [
        { id: 'visible', directory: second, status: 'done' },
        { id: 'visible', directory: second, status: 'done' },
        ...Array.from({ length: 498 }, (_, i) => ({
          id: `foreign-${i}`,
          directory: foreign,
          status: 'done',
        })),
      ],
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
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
    removeDir(foreign);
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

test('one all-tasks response retains newest-first ordering and applies a total cap', async () => {
  const second = tempDir('tf-list-cap-');
  let root = '';
  const daemon = await stubDaemon((req) =>
    okReply(req, {
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
    assert.equal(body.counts.done, 500);
    assert.equal(body.tasks[0].id, 'task-599');
    assert.equal(body.tasks[499].id, 'task-100');
    assert.match(body.note, /cap reached/);
    assert.equal(daemon.calls.length, 1);
    assert.deepEqual(daemon.calls[0]?.params, {});
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(second);
  }
});

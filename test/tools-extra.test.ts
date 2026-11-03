import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  TASK_STATUS,
  type Call,
  call,
  okReply,
  removeDir,
  startBridge,
  stubDaemon,
  tempDir,
  toolCall,
} from './helpers.ts';

const TASK_ID = 'mine';
const FOREIGN_ID = 'foreign';
const WORKTREE_TOOL = 'taskferry_worktree';
const MESSAGE_TOOL = 'taskferry_message';
const SECRET_FILE = 'secret.txt';

const statusFor = (req: Call, root: string) =>
  okReply(req, {
    id: req.params.taskId,
    directory: req.params.taskId === FOREIGN_ID ? '/private/other-project' : root,
    status: 'done',
  });

test('accept, reject and cancel are scoped and forward only their arguments', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => {
    if (req.method === TASK_STATUS) return statusFor(req, root);
    return okReply(req, { taskId: req.params.taskId, changesetStatus: 'accepted' });
  });
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir] });
  try {
    for (const name of ['taskferry_accept', 'taskferry_reject', 'taskferry_cancel']) {
      const denied = await call(bridge.url, toolCall(name, { taskId: FOREIGN_ID }));
      assert.equal(denied.result?.isError, true, `${name} must refuse a foreign task`);
      assert.doesNotMatch(JSON.stringify(denied), /private\/other-project|SECRET/);
    }
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS, TASK_STATUS, TASK_STATUS],
    );

    const accept = await call(bridge.url, toolCall('taskferry_accept', { taskId: TASK_ID }));
    assert.notEqual(accept.result?.isError, true);
    const reject = await call(bridge.url, toolCall('taskferry_reject', { taskId: TASK_ID }));
    assert.notEqual(reject.result?.isError, true);
    const cancel = await call(
      bridge.url,
      toolCall('taskferry_cancel', { taskId: TASK_ID, graceMs: 1500 }),
    );
    assert.notEqual(cancel.result?.isError, true);

    assert.deepEqual(
      daemon.calls.slice(3).map((c) => [c.method, c.params]),
      [
        [TASK_STATUS, { taskId: TASK_ID }],
        ['task.accept', { taskId: TASK_ID }],
        [TASK_STATUS, { taskId: TASK_ID }],
        ['task.reject', { taskId: TASK_ID }],
        [TASK_STATUS, { taskId: TASK_ID }],
        ['task.cancel', { taskId: TASK_ID, graceMs: 1500 }],
      ],
    );

    const forced = await call(
      bridge.url,
      toolCall('taskferry_accept', { taskId: TASK_ID, force: true }),
    );
    assert.equal(forced.result?.isError, true, 'accept must not expose force over MCP');
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('worktree lists and reads only inside the task directory', async () => {
  let root = '';
  const outside = tempDir('tf-outside-');
  const daemon = await stubDaemon((req) => statusFor(req, root));
  root = daemon.dir;
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'README.md'), '# hello\n');
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(path.join(outside, SECRET_FILE), 'SECRET');
  symlinkSync(path.join(outside, SECRET_FILE), path.join(root, 'leak.txt'));
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    const listed = await call(bridge.url, toolCall(WORKTREE_TOOL, { taskId: TASK_ID }));
    assert.notEqual(listed.result?.isError, true);
    const listing = JSON.parse(listed.result?.content?.[0]?.text ?? '{}');
    assert.equal(listing.kind, 'directory');
    assert.equal(listing.path, '.');
    assert.ok(
      listing.entries.some(
        (e: { name: string; type: string }) => e.name === 'README.md' && e.type === 'file',
      ),
    );
    assert.ok(
      listing.entries.some(
        (e: { name: string; type: string }) => e.name === 'src' && e.type === 'directory',
      ),
    );
    assert.ok(
      listing.entries.some(
        (e: { name: string; type: string }) => e.name === 'leak.txt' && e.type === 'symlink',
      ),
    );

    const nested = await call(
      bridge.url,
      toolCall(WORKTREE_TOOL, { taskId: TASK_ID, path: 'src' }),
    );
    const src = JSON.parse(nested.result?.content?.[0]?.text ?? '{}');
    assert.deepEqual(
      src.entries.map((e: { name: string }) => e.name),
      ['app.ts'],
    );

    const file = await call(
      bridge.url,
      toolCall(WORKTREE_TOOL, { taskId: TASK_ID, path: 'README.md' }),
    );
    const readme = JSON.parse(file.result?.content?.[0]?.text ?? '{}');
    assert.equal(readme.kind, 'file');
    assert.equal(readme.content, '# hello\n');
    assert.equal(readme.binary, false);
    assert.equal(readme.truncated, false);

    const binary = await call(
      bridge.url,
      toolCall(WORKTREE_TOOL, { taskId: TASK_ID, path: 'data.bin' }),
    );
    const bin = JSON.parse(binary.result?.content?.[0]?.text ?? '{}');
    assert.equal(bin.binary, true);
    assert.equal(bin.content, null);

    for (const deniedPath of [
      '../' + path.basename(outside) + '/secret.txt',
      path.join(outside, SECRET_FILE),
      'leak.txt',
    ]) {
      const denied = await call(
        bridge.url,
        toolCall(WORKTREE_TOOL, { taskId: TASK_ID, path: deniedPath }),
      );
      assert.equal(denied.result?.isError, true, `${deniedPath} must be refused`);
      assert.doesNotMatch(JSON.stringify(denied), /SECRET/);
    }

    const foreign = await call(
      bridge.url,
      toolCall(WORKTREE_TOOL, { taskId: FOREIGN_ID, path: SECRET_FILE }),
    );
    assert.equal(foreign.result?.isError, true);
    assert.doesNotMatch(JSON.stringify(foreign), /SECRET|private\/other-project/);
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(outside);
  }
});

test('message previews without confirmation, then returns the whole field page by page', async () => {
  let root = '';
  const message = 'A'.repeat(300) + 'B'.repeat(300);
  const daemon = await stubDaemon((req) => {
    if (req.method === TASK_STATUS) return statusFor(req, root);
    return okReply(req, { taskId: req.params.taskId, status: 'done', message });
  });
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    const preview = await call(bridge.url, toolCall(MESSAGE_TOOL, { taskId: TASK_ID }));
    assert.notEqual(preview.result?.isError, true);
    const previewText = preview.result?.content?.[0]?.text ?? '';
    const previewBody = JSON.parse(previewText);
    assert.equal(previewBody.messageChars, 600);
    assert.equal(previewBody.preview, 'A'.repeat(300) + 'B'.repeat(200));
    assert.equal(previewBody.message, undefined);
    assert.match(previewBody.note, /confirm: true/);
    assert.equal(previewText.includes('A'.repeat(501)), false);

    const full = await call(bridge.url, toolCall(MESSAGE_TOOL, { taskId: TASK_ID, confirm: true }));
    const fullBody = JSON.parse(full.result?.content?.[0]?.text ?? '{}');
    assert.equal(fullBody.message, message);
    assert.equal(fullBody.messageChars, 600);
    assert.equal(fullBody.truncated, false);

    const page = await call(
      bridge.url,
      toolCall(MESSAGE_TOOL, { taskId: TASK_ID, confirm: true, offset: 250, limit: 100 }),
    );
    const pageBody = JSON.parse(page.result?.content?.[0]?.text ?? '{}');
    assert.equal(pageBody.message, message.slice(250, 350));
    assert.equal(pageBody.returnedChars, 100);
    assert.equal(pageBody.truncated, true);
    assert.equal(pageBody.nextOffset, 350);

    const unconfirmedPage = await call(
      bridge.url,
      toolCall(MESSAGE_TOOL, { taskId: TASK_ID, offset: 250, limit: 100 }),
    );
    const unconfirmedBody = JSON.parse(unconfirmedPage.result?.content?.[0]?.text ?? '{}');
    assert.equal(unconfirmedBody.message, undefined);
    assert.equal(unconfirmedBody.preview.length, 500);

    const foreign = await call(
      bridge.url,
      toolCall(MESSAGE_TOOL, { taskId: FOREIGN_ID, confirm: true }),
    );
    assert.equal(foreign.result?.isError, true);
    assert.doesNotMatch(JSON.stringify(foreign), new RegExp(message.slice(0, 40)));

    const resultCalls = daemon.calls.filter((c) => c.method === 'task.result');
    assert.equal(resultCalls.length, 4);
    for (const resultCall of resultCalls) {
      assert.deepEqual(resultCall.params, { taskId: TASK_ID, fields: ['message'] });
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

for (const character of ['é', '€']) {
  for (const offset of [0, 262144]) {
    test(`worktree aligns UTF-8 pages containing ${character} at ${offset}`, async () => {
      let root = '';
      const daemon = await stubDaemon((req) => statusFor(req, root));
      root = daemon.dir;
      writeFileSync(path.join(root, 'unicode.txt'), 'a'.repeat(262143) + character + 'tail');
      const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
      try {
        const response = await call(
          bridge.url,
          toolCall(WORKTREE_TOOL, { taskId: TASK_ID, path: 'unicode.txt', offset }),
        );
        const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
        assert.equal(body.binary, false, `offset ${offset}`);
        assert.doesNotMatch(body.content, /�/);
        assert.equal(Buffer.byteLength(body.content), body.bytesRead);
        assert.ok(body.offset + body.bytesRead > offset, 'paging must advance');
      } finally {
        await bridge.close();
        await daemon.close();
      }
    });
  }
}

test('UTF-8 paging advances even when the byte budget is smaller than a character', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => statusFor(req, root));
  root = daemon.dir;
  const text = 'é€😀tail';
  writeFileSync(path.join(root, 'tiny.txt'), text);
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    let offset = 0;
    let content = '';
    while (offset < Buffer.byteLength(text)) {
      const response = await call(
        bridge.url,
        toolCall(WORKTREE_TOOL, { offset, taskId: TASK_ID, path: 'tiny.txt', maxBytes: 1 }),
      );
      const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
      assert.equal(body.binary, false);
      assert.ok(body.bytesRead > 0);
      assert.ok(body.bytesRead <= 4);
      content += body.content;
      offset = body.offset + body.bytesRead;
    }
    assert.equal(content, text);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test(
  'worktree pages past 10 MB and uses the shared truncation result',
  { timeout: 30_000 },
  async () => {
    let root = '';
    const daemon = await stubDaemon((req) => statusFor(req, root));
    root = daemon.dir;
    const size = 12 * 1024 * 1024;
    const file = path.join(root, 'large.bin');
    writeFileSync(file, '');
    truncateSync(file, size);
    const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
    try {
      const response = await call(
        bridge.url,
        toolCall(WORKTREE_TOOL, {
          taskId: TASK_ID,
          path: 'large.bin',
          offset: 10_000_000,
          maxBytes: 1024 * 1024,
        }),
      );
      const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
      assert.equal(body.offset, 10_000_000);
      assert.equal(body.bytesRead, 1024 * 1024);
      assert.equal(body.truncated, true);
      assert.equal(body.nextOffset, 11_048_576);
      assert.equal(body.size, size);
    } finally {
      await bridge.close();
      await daemon.close();
    }
  },
);

test('worktree directory paging options explain that they apply only to files', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => statusFor(req, root));
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
  try {
    for (const options of [{ offset: 0 }, { maxBytes: 1 }]) {
      const response = await call(
        bridge.url,
        toolCall(WORKTREE_TOOL, { taskId: TASK_ID, ...options }),
      );
      const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
      assert.match(body.note, /file reads only/);
    }
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

for (const field of ['status', 'preview']) {
  test(`message uses configured preview and guarded status: ${field}`, async () => {
    let root = '';
    const daemon = await stubDaemon((req) =>
      req.method === TASK_STATUS
        ? statusFor(req, root)
        : okReply(req, { status: 'running', message: 'abcdef' }),
    );
    root = daemon.dir;
    const bridge = await startBridge(daemon.socket, { allowDirectories: [root], previewChars: 3 });
    try {
      const response = await call(bridge.url, toolCall(MESSAGE_TOOL, { taskId: TASK_ID }));
      const body = JSON.parse(response.result?.content?.[0]?.text ?? '{}');
      assert.equal(body[field], field === 'status' ? 'done' : 'abc');
    } finally {
      await bridge.close();
      await daemon.close();
    }
  });
}

test('accept and reject use six times the configured daemon timeout', async (t) => {
  const timeouts: number[] = [];
  const original = net.Socket.prototype.setTimeout;
  t.mock.method(
    net.Socket.prototype,
    'setTimeout',
    function (this: net.Socket, timeout: number, callback?: () => void) {
      if (this.connecting) timeouts.push(timeout);
      return original.call(this, timeout, callback);
    },
  );
  let root = '';
  const daemon = await stubDaemon((req) => statusFor(req, root));
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [root],
    daemonTimeoutMs: 1000,
  });
  try {
    for (const name of ['taskferry_accept', 'taskferry_reject']) {
      const response = await call(bridge.url, toolCall(name, { taskId: TASK_ID }));
      assert.notEqual(response.result?.isError, true);
    }
    assert.equal(timeouts.filter((timeout) => timeout === 6000).length, 2);
    assert.equal(timeouts.filter((timeout) => timeout === 1000).length, 2);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

for (const denyDev of [false, true]) {
  test(`worktree descriptor resolution with dev fd denied: ${denyDev}`, async (t) => {
    let root = '';
    const daemon = await stubDaemon((req) => statusFor(req, root));
    root = daemon.dir;
    writeFileSync(path.join(root, 'file.txt'), 'hello');
    const bridge = await startBridge(daemon.socket, { allowDirectories: [root] });
    const attempts: string[] = [];
    const originalSync = fs.realpathSync;
    const originalAsync = fsPromises.realpath;
    const check = (value: unknown) => {
      const name = String(value);
      if (name.startsWith('/proc/self/fd/') || name.startsWith('/dev/fd/')) {
        attempts.push(name);
        if (name.startsWith('/proc/') || denyDev) throw new Error('descriptor path unavailable');
      }
    };
    t.mock.method(fs, 'realpathSync', (value: fs.PathLike) => {
      check(value);
      return originalSync(value);
    });
    t.mock.method(fsPromises, 'realpath', async (value: fs.PathLike) => {
      check(value);
      return originalAsync(value);
    });
    syncBuiltinESMExports();
    try {
      const args = { taskId: TASK_ID, path: 'file.txt' };
      const response = await call(bridge.url, toolCall(WORKTREE_TOOL, args));
      if (denyDev) {
        assert.equal(response.result?.isError, true);
        assert.match(response.result?.content?.[0]?.text ?? '', /path unavailable/);
      } else {
        assert.notEqual(response.result?.isError, true);
        assert.ok(attempts.some((name) => name.startsWith('/dev/fd/')));
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await bridge.close();
      await daemon.close();
    }
  });
}

for (const setting of ['timeout', 'cache TTL']) {
  test(`model listing uses the configured ${setting}`, async (t) => {
    const dir = tempDir('tf-model-command-');
    const command = path.join(dir, 'opencode');
    const oldPath = process.env.PATH;
    let now = Date.now() + (setting === 'cache TTL' ? 120000 : 0);
    t.mock.method(Date, 'now', () => now);
    process.env.PATH = `${dir}:${oldPath}`;
    writeFileSync(command, '#!/bin/sh\nprintf "one/model\\n"\n', { mode: 0o700 });
    const daemon = await stubDaemon((req) => okReply(req, {}));
    const bridge = await startBridge(daemon.socket, { modelsCacheTtlMs: 10, listTimeoutMs: 100 });
    const models = () => call(bridge.url, toolCall('taskferry_models', { query: 'model' }));
    try {
      const first = await models();
      assert.equal(JSON.parse(first.result?.content?.[0]?.text ?? '{}').models[0].id, 'one/model');
      if (setting === 'cache TTL') {
        writeFileSync(command, '#!/bin/sh\nprintf "two/model\\n"\n');
        const cached = await models();
        assert.equal(
          JSON.parse(cached.result?.content?.[0]?.text ?? '{}').models[0].id,
          'one/model',
        );
        now += 11;
        const expired = await models();
        assert.equal(
          JSON.parse(expired.result?.content?.[0]?.text ?? '{}').models[0].id,
          'two/model',
        );
      } else {
        writeFileSync(command, '#!/bin/sh\nexec sleep 2\n');
        now += 60001;
        const timedOut = await models();
        assert.equal(timedOut.result?.isError, true);
        assert.match(timedOut.result?.content?.[0]?.text ?? '', /model catalog unavailable/);
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await bridge.close();
      await daemon.close();
      removeDir(dir);
    }
  });
}

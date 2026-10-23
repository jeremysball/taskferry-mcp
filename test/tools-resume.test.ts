import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { skillBindPaths } from '../src/skills.ts';
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

const RESUME_TOOL = 'taskferry_resume';
const TASK_ID = 'mine';
const FOREIGN_ID = 'foreign';
const SESSION_ID = 'ses_resume';
const MODEL = 'good';
const PROMPT = 'continue';
const NEW_TASK_ID = 'new-task';
const DONE = 'done';
const RUNNING = 'running';
const FOREIGN_DIRECTORY = '/private/other-project';
const TASK_DISPATCH = 'task.dispatch';

type TaskFields = {
  directory: string;
  status: string;
  sessionId?: string;
  model?: string;
};

const statusReply = (req: Call, fields: TaskFields) =>
  okReply(req, { id: req.params.taskId, ...fields });

const resume = (url: string, args: Record<string, unknown>) =>
  call(url, toolCall(RESUME_TOOL, args));

test('resume derives the workspace, model and session from the source task', async () => {
  let root = '';
  const daemon = await stubDaemon((req) => {
    if (req.method === TASK_STATUS) {
      return statusReply(req, {
        directory: req.params.taskId === FOREIGN_ID ? FOREIGN_DIRECTORY : root,
        status: DONE,
        sessionId: SESSION_ID,
        model: MODEL,
      });
    }
    return okReply(req, { id: NEW_TASK_ID });
  });
  root = daemon.dir;
  const roRoot = tempDir('tf-resume-ro-');
  const credential = `${roRoot}/auth.json`;
  writeFileSync(credential, '{}');
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
    allowRoBinds: [credential],
  });
  try {
    const result = await resume(bridge.url, {
      taskId: TASK_ID,
      prompt: PROMPT,
      variant: 'high',
      roBind: [credential],
    });
    assert.notEqual(result.result?.isError, true);
    assert.deepEqual(
      daemon.calls.map((c) => [c.method, c.params]),
      [
        [TASK_STATUS, { taskId: TASK_ID }],
        [
          TASK_DISPATCH,
          {
            directory: daemon.dir,
            model: MODEL,
            prompt: PROMPT,
            sessionId: SESSION_ID,
            variant: 'high',
            roBind: [...skillBindPaths('worker'), credential],
          },
        ],
      ],
    );
  } finally {
    await bridge.close();
    await daemon.close();
    removeDir(roRoot);
  }
});

test('resume refuses a foreign task without dispatching', async () => {
  let root = '';
  const daemon = await stubDaemon((req) =>
    statusReply(req, {
      directory: req.params.taskId === FOREIGN_ID ? FOREIGN_DIRECTORY : root,
      status: DONE,
      sessionId: SESSION_ID,
      model: MODEL,
    }),
  );
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
  });
  try {
    const denied = await resume(bridge.url, { taskId: FOREIGN_ID, prompt: PROMPT });
    assert.equal(denied.result?.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /private\/other-project|ses_resume/);
    assert.deepEqual(
      daemon.calls.map((c) => c.method),
      [TASK_STATUS],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('resume refuses running, sessionless and disallowed-model tasks', async () => {
  let root = '';
  let mode = 'running';
  const daemon = await stubDaemon((req) => {
    if (mode === 'running') {
      return statusReply(req, {
        directory: root,
        status: RUNNING,
        sessionId: SESSION_ID,
        model: MODEL,
      });
    }
    if (mode === 'no-session') {
      return statusReply(req, { directory: root, status: DONE, model: MODEL });
    }
    return statusReply(req, { directory: root, status: DONE, sessionId: SESSION_ID, model: 'bad' });
  });
  root = daemon.dir;
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
  });
  try {
    const running = await resume(bridge.url, { taskId: TASK_ID, prompt: PROMPT });
    assert.equal(running.result?.isError, true);
    assert.match(running.result?.content?.[0]?.text ?? '', /still running/);

    mode = 'no-session';
    const sessionless = await resume(bridge.url, { taskId: TASK_ID, prompt: PROMPT });
    assert.equal(sessionless.result?.isError, true);
    assert.match(sessionless.result?.content?.[0]?.text ?? '', /no resumable session/);

    mode = 'bad-model';
    const denied = await resume(bridge.url, { taskId: TASK_ID, prompt: PROMPT });
    assert.equal(denied.result?.isError, true);
    assert.match(denied.result?.content?.[0]?.text ?? '', /model denied: bad/);
    assert.deepEqual(
      daemon.calls.filter((c) => c.method === TASK_DISPATCH),
      [],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('resume rejects caller-supplied workspace, model and session overrides', async () => {
  const daemon = await stubDaemon((req) =>
    statusReply(req, { directory: daemon.dir, status: DONE, sessionId: SESSION_ID, model: MODEL }),
  );
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
  });
  try {
    for (const extra of [{ directory: daemon.dir }, { model: MODEL }, { sessionId: SESSION_ID }]) {
      const rejected = await resume(bridge.url, {
        taskId: TASK_ID,
        prompt: PROMPT,
        ...extra,
      });
      assert.equal(rejected.result?.isError, true, JSON.stringify(extra));
    }
    assert.equal(daemon.calls.length, 0, 'unknown keys must be rejected before reading status');
    assert.deepEqual(
      daemon.calls.filter((c) => c.method === TASK_DISPATCH),
      [],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('resume refuses a missing sessionId with an otherwise valid source', async () => {
  const daemon = await stubDaemon((req) =>
    statusReply(req, { directory: daemon.dir, status: DONE, model: MODEL }),
  );
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [MODEL],
  });
  try {
    const response = await resume(bridge.url, { taskId: TASK_ID, prompt: PROMPT });
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content?.[0]?.text ?? '', /no resumable session/);
    assert.deepEqual(
      daemon.calls.map((req) => req.method),
      [TASK_STATUS],
    );
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

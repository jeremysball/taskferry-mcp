import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { call, okReply, startBridge, stubDaemon, toolCall } from './helpers.ts';

test('dispatch forwards noSandbox only when the caller sets it', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  const dispatch = (noSandboxArgs: Record<string, unknown> = {}) =>
    call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        prompt: 'hi',
        ...noSandboxArgs,
        model,
      }),
    );
  try {
    const omitted = await dispatch();
    assert.notEqual(omitted.result?.isError, true);
    assert.deepEqual(daemon.calls[0]?.params, {
      directory: daemon.dir,
      prompt: 'hi',
      model,
    });

    const enabled = await dispatch({ noSandbox: true });
    assert.notEqual(enabled.result?.isError, true);
    assert.deepEqual(daemon.calls[1]?.params, {
      directory: daemon.dir,
      prompt: 'hi',
      noSandbox: true,
      model,
    });

    const disabled = await dispatch({ noSandbox: false });
    assert.notEqual(disabled.result?.isError, true);
    assert.deepEqual(daemon.calls[2]?.params, {
      directory: daemon.dir,
      prompt: 'hi',
      noSandbox: false,
      model,
    });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('dispatch rejects nonboolean noSandbox before calling the daemon', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    skillProfile: 'none',
  });
  try {
    for (const noSandbox of ['true', 1, null, {}, []]) {
      const res = await call(
        bridge.url,
        toolCall('taskferry_dispatch', {
          directory: daemon.dir,
          prompt: 'hi',
          noSandbox,
          model,
        }),
      );
      assert.equal(res.result?.isError, true, JSON.stringify(noSandbox));
    }
    assert.equal(daemon.calls.length, 0);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('noSandbox true still honors directory, model and bind allowlists', async () => {
  const daemon = await stubDaemon((req) => okReply(req, { id: 'new-task' }));
  const model = 'good';
  const allowedBindDir = path.join(daemon.dir, 'allowed-bind');
  const outsideBind = path.join(daemon.dir, 'outside-bind');
  mkdirSync(allowedBindDir);
  writeFileSync(outsideBind, '{}');
  const bridge = await startBridge(daemon.socket, {
    allowDirectories: [daemon.dir],
    allowModels: [model],
    allowRoBinds: [allowedBindDir],
    skillProfile: 'none',
  });
  try {
    const deniedDirectory = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: '/',
        prompt: 'hi',
        noSandbox: true,
        model,
      }),
    );
    assert.equal(deniedDirectory.result?.isError, true, 'directory');

    const deniedModel = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        prompt: 'hi',
        noSandbox: true,
        model: 'bad',
      }),
    );
    assert.equal(deniedModel.result?.isError, true, 'model');

    const deniedBind = await call(
      bridge.url,
      toolCall('taskferry_dispatch', {
        directory: daemon.dir,
        prompt: 'hi',
        noSandbox: true,
        roBind: [outsideBind],
        model,
      }),
    );
    assert.equal(deniedBind.result?.isError, true, 'bind');
    assert.equal(daemon.calls.length, 0);
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

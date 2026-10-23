import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { ConfigError, resolveConfig } from '../src/config.ts';
import {
  HEALTH,
  call,
  removeDir,
  startBridge,
  stubDaemon,
  tempDir,
  toolCall,
  okReply,
} from './helpers.ts';

const CONFIG_FILE = 'config.json';
const FILE_SECRET = 'file-secret';
const PORT = 8787;
const TOKEN_FILE_FLAG = '--token-file';
const LISTEN_PORT_FLAG = '--listen-port';

const BASE_ENV = {
  XDG_RUNTIME_DIR: '/run/user/9',
  XDG_CONFIG_HOME: '/nonexistent-config-home',
  TASKFERRY_MCP_TOKEN: 'secret',
};
const resolve = (argv: string[] = [], env: Record<string, string | undefined> = {}) =>
  resolveConfig({ argv, env: { ...BASE_ENV, ...env } });

function withFiles(run: (dir: string) => void) {
  const dir = tempDir('tf-config-');
  try {
    run(dir);
  } finally {
    removeDir(dir);
  }
}
const writeJson = (file: string, value: unknown, mode = 0o600) => {
  writeFileSync(file, JSON.stringify(value), { mode });
  chmodSync(file, mode);
};

test('defaults: the daemon socket and the listener both live in the XDG runtime dir', () => {
  const c = resolve();
  assert.equal(c.daemonSocket, '/run/user/9/taskferry/daemon.sock');
  assert.deepEqual(c.listen, { kind: 'unix', path: '/run/user/9/taskferry-mcp/mcp.sock' });
  assert.deepEqual(c.allowDirectories, []);
  assert.deepEqual(c.allowModels, []);
  assert.deepEqual(c.allowRoBinds, []);
  assert.equal(c.token, 'secret');
});

test('TASKFERRY_RUNTIME_DIR moves the daemon socket default, as it does for the daemon itself', () => {
  const c = resolve([], { TASKFERRY_RUNTIME_DIR: '/run/custom' });
  assert.equal(c.daemonSocket, '/run/custom/daemon.sock');
});

test('precedence is flag over env over config key over default, for every knob', () => {
  withFiles((dir) => {
    const file = path.join(dir, CONFIG_FILE);
    writeJson(file, {
      daemonTimeoutMs: 101,
      listTimeoutMs: 102,
      modelsCacheTtlMs: 103,
      previewChars: 104,
      daemonSocket: '/from/file.sock',
      allowedDirectories: ['/file-a', '/file-b'],
      allowedModels: ['file-model'],
      allowedRoBinds: ['/file-bind'],
      listenSocket: '/from/file-listen.sock',
    });
    const fromFile = resolve(['--config', file]);
    assert.deepEqual(
      [
        fromFile.daemonTimeoutMs,
        fromFile.listTimeoutMs,
        fromFile.modelsCacheTtlMs,
        fromFile.previewChars,
      ],
      [101, 102, 103, 104],
    );
    assert.equal(fromFile.daemonSocket, '/from/file.sock');
    assert.deepEqual(fromFile.allowDirectories, ['/file-a', '/file-b']);
    assert.deepEqual(fromFile.allowModels, ['file-model']);
    assert.deepEqual(fromFile.allowRoBinds, ['/file-bind']);
    assert.deepEqual(fromFile.listen, { kind: 'unix', path: '/from/file-listen.sock' });

    const env = {
      TASKFERRY_MCP_DAEMON_TIMEOUT_MS: '201',
      TASKFERRY_MCP_LIST_TIMEOUT_MS: '202',
      TASKFERRY_MCP_MODELS_CACHE_TTL_MS: '203',
      TASKFERRY_MCP_PREVIEW_CHARS: '204',
      TASKFERRY_SOCKET_PATH: '/from/env.sock',
      TASKFERRY_ALLOWED_DIRECTORIES: '/env-a:/env-b',
      TASKFERRY_ALLOWED_MODELS: 'env-1,env-2',
      TASKFERRY_ALLOWED_RO_BINDS: '/env-bind',
      TASKFERRY_MCP_LISTEN_SOCKET: '/from/env-listen.sock',
    };
    const fromEnv = resolve(['--config', file], env);
    assert.deepEqual(
      [
        fromEnv.daemonTimeoutMs,
        fromEnv.listTimeoutMs,
        fromEnv.modelsCacheTtlMs,
        fromEnv.previewChars,
      ],
      [201, 202, 203, 204],
    );
    assert.equal(fromEnv.daemonSocket, '/from/env.sock');
    assert.deepEqual(fromEnv.allowDirectories, ['/env-a', '/env-b']);
    assert.deepEqual(fromEnv.allowModels, ['env-1', 'env-2']);
    assert.deepEqual(fromEnv.allowRoBinds, ['/env-bind']);
    assert.deepEqual(fromEnv.listen, { kind: 'unix', path: '/from/env-listen.sock' });

    const fromFlag = resolve(
      [
        '--config',
        file,
        '--daemon-timeout-ms',
        '301',
        '--list-timeout-ms',
        '302',
        '--models-cache-ttl-ms',
        '303',
        '--preview-chars',
        '304',
        '--daemon-socket',
        '/from/flag.sock',
        '--allowed-directories',
        '/flag-a',
        '--allowed-models',
        'flag-1',
        '--allowed-ro-binds',
        '/flag-bind',
        '--listen-socket',
        '/from/flag-listen.sock',
      ],
      env,
    );
    assert.equal(fromFlag.daemonSocket, '/from/flag.sock');
    assert.deepEqual(
      [
        fromFlag.daemonTimeoutMs,
        fromFlag.listTimeoutMs,
        fromFlag.modelsCacheTtlMs,
        fromFlag.previewChars,
      ],
      [301, 302, 303, 304],
    );
    assert.deepEqual(fromFlag.allowDirectories, ['/flag-a']);
    assert.deepEqual(fromFlag.allowModels, ['flag-1']);
    assert.deepEqual(fromFlag.allowRoBinds, ['/flag-bind']);
    assert.deepEqual(fromFlag.listen, { kind: 'unix', path: '/from/flag-listen.sock' });
  });
});

test('the config file can come from the flag, the env var, or the XDG default', () => {
  withFiles((dir) => {
    const viaEnv = path.join(dir, 'env.json');
    const viaFlag = path.join(dir, 'flag.json');
    writeJson(viaEnv, { allowedModels: ['from-env-file'] });
    writeJson(viaFlag, { allowedModels: ['from-flag-file'] });
    assert.deepEqual(resolve([], { TASKFERRY_MCP_CONFIG: viaEnv }).allowModels, ['from-env-file']);
    assert.deepEqual(resolve(['--config', viaFlag], { TASKFERRY_MCP_CONFIG: viaEnv }).allowModels, [
      'from-flag-file',
    ]);
    const defaultFile = path.join(dir, 'taskferry-mcp', CONFIG_FILE);
    mkdirSync(path.dirname(defaultFile));
    writeJson(defaultFile, { allowedModels: ['from-xdg-file'] });
    assert.deepEqual(resolve([], { XDG_CONFIG_HOME: dir }).allowModels, ['from-xdg-file']);
    assert.deepEqual(resolve([]).allowModels, [], 'an absent default file is not an error');
  });
});

test('a config file that was asked for but is missing, unreadable, or not an object fails', () => {
  withFiles((dir) => {
    assert.throws(() => resolve(['--config', path.join(dir, 'missing.json')]), ConfigError);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    assert.throws(() => resolve(['--config', bad]), /bad\.json/);
    const array = path.join(dir, 'array.json');
    writeJson(array, []);
    assert.throws(() => resolve(['--config', array]), /must be a JSON object/);
  });
});

test('an unknown key in the config file is an error, so a typo cannot silently drop a knob', () => {
  withFiles((dir) => {
    const file = path.join(dir, CONFIG_FILE);
    writeJson(file, { allowedDirectoriez: ['/x'] });
    assert.throws(() => resolve(['--config', file]), /unknown config key "allowedDirectoriez"/);
  });
});

test('the token is never a config-file key or a flag, because both leak through ps and backups', () => {
  withFiles((dir) => {
    const file = path.join(dir, CONFIG_FILE);
    writeJson(file, { token: 'x' });
    assert.throws(() => resolve(['--config', file]), /unknown config key "token"/);
    assert.throws(() => resolve(['--token', 'x']), ConfigError);
  });
});

test('the token comes from the env var or from a private file, never both, never neither', () => {
  withFiles((dir) => {
    const tokenFile = path.join(dir, 'token');
    writeFileSync(tokenFile, `${FILE_SECRET}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const noEnv = { TASKFERRY_MCP_TOKEN: '' };
    assert.equal(resolve([TOKEN_FILE_FLAG, tokenFile], noEnv).token, FILE_SECRET);
    assert.equal(resolve([], { ...noEnv, TASKFERRY_MCP_TOKEN_FILE: tokenFile }).token, FILE_SECRET);
    assert.throws(() => resolve([TOKEN_FILE_FLAG, tokenFile]), /either TASKFERRY_MCP_TOKEN or/);
    assert.throws(() => resolve([], noEnv), /bearer token required/);
    assert.throws(() => resolve([], { TASKFERRY_MCP_TOKEN: '   ' }), /bearer token required/);
  });
});

test('a token file anyone else can read, or that is empty, is refused', () => {
  withFiles((dir) => {
    const tokenFile = path.join(dir, 'token');
    const noEnv = { TASKFERRY_MCP_TOKEN: '' };
    writeFileSync(tokenFile, `${FILE_SECRET}\n`);
    chmodSync(tokenFile, 0o640);
    assert.throws(() => resolve([TOKEN_FILE_FLAG, tokenFile], noEnv), /mode 640/);
    chmodSync(tokenFile, 0o600);
    writeFileSync(tokenFile, '\n');
    assert.throws(() => resolve([TOKEN_FILE_FLAG, tokenFile], noEnv), /is empty/);
  });
});

test('TCP loopback mode: a port picks it, and naming both listeners is a conflict', () => {
  assert.deepEqual(resolve([LISTEN_PORT_FLAG, String(PORT)]).listen, { kind: 'tcp', port: PORT });
  assert.deepEqual(resolve([], { TASKFERRY_MCP_LISTEN_PORT: '9000' }).listen, {
    kind: 'tcp',
    port: 9000,
  });
  assert.throws(
    () => resolve([LISTEN_PORT_FLAG, String(PORT), '--listen-socket', '/x.sock']),
    /listen-port and listen-socket/,
  );
  withFiles((dir) => {
    const file = path.join(dir, CONFIG_FILE);
    writeJson(file, { listenSocket: '/file.sock' });
    // A port from a higher-precedence source wins over a socket from the file, without conflict.
    assert.deepEqual(resolve(['--config', file, LISTEN_PORT_FLAG, String(PORT)]).listen, {
      kind: 'tcp',
      port: PORT,
    });
  });
});

test('read-only bind roots must be absolute and cannot be the filesystem root', () => {
  assert.deepEqual(resolve([], { TASKFERRY_ALLOWED_RO_BINDS: '/a:/b' }).allowRoBinds, ['/a', '/b']);
  assert.throws(
    () => resolve([], { TASKFERRY_ALLOWED_RO_BINDS: 'relative/path' }),
    /must be an absolute path/,
  );
  assert.throws(() => resolve([], { TASKFERRY_ALLOWED_RO_BINDS: '/' }), /filesystem root/);
});

test('bad values fail loudly instead of falling back to a default', () => {
  for (const port of ['0', '65536', 'abc', '80.5', '']) {
    assert.throws(() => resolve([LISTEN_PORT_FLAG, port]), ConfigError, `port ${port}`);
  }
  assert.throws(() => resolve(['--no-such-flag']), ConfigError);
  assert.throws(() => resolve(['stray']), ConfigError);
  assert.throws(() => resolve([], { XDG_RUNTIME_DIR: '' }), /daemon socket/);
});

test('environment tokens are trimmed before bearer authentication', async () => {
  const config = resolve([], { TASKFERRY_MCP_TOKEN: ' secret ' });
  assert.equal(config.token, 'secret');
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const bridge = await startBridge(daemon.socket, { token: config.token });
  try {
    const response = await call(bridge.url, toolCall(HEALTH), { token: 'secret' });
    assert.deepEqual(JSON.parse(response.result?.content?.[0]?.text ?? '{}'), { healthy: true });
  } finally {
    await bridge.close();
    await daemon.close();
  }
});

test('computed socket defaults require absolute runtime paths', () => {
  assert.throws(() => resolve([], { XDG_RUNTIME_DIR: 'relative' }), /absolute path/);
  assert.throws(() => resolve([], { TASKFERRY_RUNTIME_DIR: 'relative' }), /absolute path/);
  assert.throws(
    () => resolve(['--daemon-socket', '/daemon.sock'], { XDG_RUNTIME_DIR: 'relative' }),
    /absolute path/,
  );
  assert.equal(
    resolve([], { XDG_RUNTIME_DIR: '/run/absolute' }).daemonSocket,
    '/run/absolute/taskferry/daemon.sock',
  );
});

test('limit defaults and invalid positive integers', () => {
  const config = resolve();
  assert.deepEqual(
    [config.daemonTimeoutMs, config.listTimeoutMs, config.modelsCacheTtlMs, config.previewChars],
    [5000, 15000, 60000, 500],
  );
  for (const flag of [
    '--daemon-timeout-ms',
    '--list-timeout-ms',
    '--models-cache-ttl-ms',
    '--preview-chars',
  ]) {
    for (const value of ['0', '-1', '1.5', 'no', '9007199254740992']) {
      assert.throws(() => resolve([flag, value]), ConfigError);
    }
  }
});

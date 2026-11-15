import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, writeFileSync } from 'node:fs';
import { ConfigError, resolveConfig } from '../src/config.ts';
import { DEFAULT_REDIRECTS } from '../src/oauth-config.ts';
import { removeDir, tempDir } from './helpers.ts';

const SECRET_FILE_FLAG = '--oauth-secret-file';
const STATE_FLAG = '--oauth-state';
const ENV_ORIGIN = 'https://from-env.example.com';
const SECRET = 'owner-approval-secret-0123456789';
const PUBLIC_URL = 'https://mcp.example.com';
const BASE_ENV = {
  XDG_RUNTIME_DIR: '/run/user/9',
  XDG_STATE_HOME: '/state',
  XDG_CONFIG_HOME: '/nonexistent-config-home',
  TASKFERRY_MCP_TOKEN: 'bridge-token',
};
const ON = {
  TASKFERRY_MCP_PUBLIC_URL: PUBLIC_URL,
  TASKFERRY_MCP_OAUTH_SECRET: SECRET,
};
const resolve = (argv: string[] = [], env: Record<string, string | undefined> = {}) =>
  resolveConfig({ argv, env: { ...BASE_ENV, ...env } });
const assertRefused = (pattern: RegExp, argv: string[] = [], env = {}) =>
  assert.throws(
    () => resolve(argv, env),
    (error) => error instanceof ConfigError && pattern.test(error.message),
  );

function withDir(run: (dir: string) => void) {
  const dir = tempDir('tf-oauth-config-');
  try {
    run(dir);
  } finally {
    removeDir(dir);
  }
}
const writeSecret = (file: string, text: string, mode = 0o600) => {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
};

test('OAuth is off unless a public URL is configured', () => {
  assert.equal(resolve().oauth, undefined);
});

test('a public URL and a secret turn OAuth on, with Claude-ready defaults', () => {
  const { oauth } = resolve([], ON);
  assert.ok(oauth);
  assert.equal(oauth.origin, PUBLIC_URL);
  assert.equal(oauth.hostname, 'mcp.example.com');
  assert.equal(oauth.resource, `${PUBLIC_URL}/mcp`);
  assert.equal(oauth.approvalSecret, SECRET);
  assert.deepEqual(oauth.redirects.exact, [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ]);
  assert.equal(oauth.redirects.loopback, true);
  assert.equal(oauth.statePath, '/state/taskferry-mcp/oauth.json');
  assert.deepEqual(DEFAULT_REDIRECTS.length, 3);
});

test('the public URL must be a bare https origin, or a loopback http one', () => {
  const url = (value: string) => resolve([], { ...ON, TASKFERRY_MCP_PUBLIC_URL: value });
  assert.equal(url('https://mcp.example.com/').oauth?.origin, PUBLIC_URL);
  assert.equal(
    url('https://mcp.example.com:8443').oauth?.resource,
    'https://mcp.example.com:8443/mcp',
  );
  assert.equal(url('http://127.0.0.1:8787').oauth?.origin, 'http://127.0.0.1:8787');
  assert.equal(url('http://localhost:8787').oauth?.hostname, 'localhost');
  for (const bad of [
    'https://mcp.example.com/mcp',
    'https://mcp.example.com/?x=1',
    'http://mcp.example.com',
    'https://user:pw@mcp.example.com',
    'https://mcp.example.com/#frag',
    'ftp://mcp.example.com',
    'not a url',
  ]) {
    assert.throws(() => url(bad), ConfigError, bad);
  }
  assertRefused(/bare origin/, [], {
    ...ON,
    TASKFERRY_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  });
});

test('every OAuth setting without a public URL is an error, not an ignored knob', () => {
  const cases: [string[], Record<string, string>][] = [
    [[], { TASKFERRY_MCP_OAUTH_SECRET: SECRET }],
    [[], { TASKFERRY_MCP_OAUTH_SECRET_FILE: '/x' }],
    [[SECRET_FILE_FLAG, '/x'], {}],
    [[], { TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS: 'loopback' }],
    [['--oauth-allowed-redirects', 'loopback'], {}],
    [[], { TASKFERRY_MCP_OAUTH_STATE: '/x/oauth.json' }],
    [[STATE_FLAG, '/x/oauth.json'], {}],
  ];
  for (const [argv, env] of cases) {
    assert.throws(() => resolve(argv, env), /need a public URL/, JSON.stringify([argv, env]));
  }
});

test('the approval secret must exist, be long enough and differ from the other tokens', () => {
  const only = { TASKFERRY_MCP_PUBLIC_URL: PUBLIC_URL };
  assert.throws(() => resolve([], only), /approval secret required/);
  assertRefused(/set but empty/, [], { ...only, TASKFERRY_MCP_OAUTH_SECRET: '  ' });
  assertRefused(/at least 24/, [], { ...only, TASKFERRY_MCP_OAUTH_SECRET: 'short' });
  assertRefused(/must differ from the bridge and gateway tokens/, [], {
    ...only,
    TASKFERRY_MCP_TOKEN: SECRET,
    TASKFERRY_MCP_OAUTH_SECRET: SECRET,
  });
  assertRefused(/must differ from the bridge and gateway tokens/, [], {
    ...ON,
    TASKFERRY_GATEWAY_TOKEN: SECRET,
  });
});

test('the approval secret can come from a private file, never a loose one', () => {
  withDir((dir) => {
    const file = path.join(dir, 'secret');
    const only = { TASKFERRY_MCP_PUBLIC_URL: PUBLIC_URL };
    writeSecret(file, `${SECRET}\n`);
    assert.equal(resolve([SECRET_FILE_FLAG, file], only).oauth?.approvalSecret, SECRET);
    assert.equal(
      resolve([], { ...only, TASKFERRY_MCP_OAUTH_SECRET_FILE: file }).oauth?.approvalSecret,
      SECRET,
    );
    assertRefused(/not both/, [SECRET_FILE_FLAG, file], ON);
    writeSecret(file, SECRET, 0o640);
    assertRefused(/must not be readable by group or others/, [SECRET_FILE_FLAG, file], only);
    writeSecret(file, '\n');
    assertRefused(/is empty/, [SECRET_FILE_FLAG, file], only);
    assertRefused(/cannot read token file/, [SECRET_FILE_FLAG, path.join(dir, 'missing')], only);
  });
});

test('allowed redirects replace the defaults and are validated', () => {
  // An empty variable counts as unset, so it falls back to the defaults rather than allowing none.
  assert.deepEqual(
    resolve([], { ...ON, TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS: '' }).oauth?.redirects.exact,
    DEFAULT_REDIRECTS.filter((entry) => entry !== 'loopback'),
  );
  const redirects = (value: string) =>
    resolve([], { ...ON, TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS: value }).oauth?.redirects;
  assert.deepEqual(redirects('https://app.example.com/cb'), {
    exact: ['https://app.example.com/cb'],
    loopback: false,
  });
  assert.deepEqual(redirects('https://a.example.com/cb, loopback'), {
    exact: ['https://a.example.com/cb'],
    loopback: true,
  });
  for (const bad of ['http://evil.example.com/cb', 'https://x.example.com/cb#f', 'nope']) {
    assert.throws(() => redirects(bad), ConfigError, bad);
  }
});

test('flag, env and config file resolve in that order, and the state path must be absolute', () => {
  withDir((dir) => {
    const config = path.join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        publicUrl: 'https://from-file.example.com',
        oauthStatePath: '/file/oauth.json',
        oauthAllowedRedirects: ['https://file.example.com/cb'],
      }),
      { mode: 0o600 },
    );
    chmodSync(config, 0o600);
    const env = { TASKFERRY_MCP_OAUTH_SECRET: SECRET };
    const fromFile = resolve(['--config', config], env).oauth;
    assert.equal(fromFile?.origin, 'https://from-file.example.com');
    assert.equal(fromFile?.statePath, '/file/oauth.json');
    assert.deepEqual(fromFile?.redirects.exact, ['https://file.example.com/cb']);

    const fromEnv = resolve(['--config', config], {
      ...env,
      TASKFERRY_MCP_PUBLIC_URL: ENV_ORIGIN,
      TASKFERRY_MCP_OAUTH_STATE: '/env/oauth.json',
    }).oauth;
    assert.equal(fromEnv?.origin, ENV_ORIGIN);
    assert.equal(fromEnv?.statePath, '/env/oauth.json');

    const fromFlag = resolve(
      [
        '--config',
        config,
        '--public-url',
        'https://from-flag.example.com',
        STATE_FLAG,
        '/flag/o.json',
      ],
      { ...env, TASKFERRY_MCP_PUBLIC_URL: ENV_ORIGIN },
    ).oauth;
    assert.equal(fromFlag?.origin, 'https://from-flag.example.com');
    assert.equal(fromFlag?.statePath, '/flag/o.json');

    assert.throws(() => resolve([STATE_FLAG, 'relative/oauth.json'], ON), ConfigError);
  });
});

test('a secret cannot be put in a config file or passed as a flag', () => {
  withDir((dir) => {
    const config = path.join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ publicUrl: PUBLIC_URL, oauthSecret: SECRET }), {
      mode: 0o600,
    });
    chmodSync(config, 0o600);
    assert.throws(() => resolve(['--config', config]), ConfigError);
    assert.throws(() => resolve(['--oauth-secret', SECRET], ON));
  });
});

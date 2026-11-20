import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listenBridge } from '../src/listen.ts';
import { createBridge } from '../src/server.ts';
import {
  GATEWAY_TOKEN,
  HEALTH,
  bridgeConfig,
  createSkillRoot,
  okReply,
  removeDir,
  send,
  stubDaemon,
  tempDir,
  toolCall,
} from './helpers.ts';
import {
  APPROVAL_SECRET,
  CLAUDE_CALLBACK,
  approve,
  exchange,
  getPage,
  json,
  oauthFixture,
  ROUTE,
  PUBLIC_HOST,
} from './oauth-helpers.ts';

test('the gateway surface has no OAuth endpoints and does not honour OAuth tokens', async () => {
  const f = await oauthFixture({}, { gateway: true });
  try {
    const gateway = f.gatewayUrl as string;
    const base = new URL(gateway).origin;
    for (const route of [ROUTE.prmMcp, ROUTE.metadata, ROUTE.authorize, ROUTE.token]) {
      assert.equal((await getPage(`${base}${route}`)).status, 404, route);
    }

    const tokens = json(await exchange(f, await approve(f)));
    const access = tokens.access_token as string;
    assert.equal((await send(f.mcp, toolCall(HEALTH), { token: access })).status, 200);
    const refused = await send(gateway, toolCall(HEALTH), { token: access });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers['www-authenticate'], 'Bearer');
    assert.equal((await send(gateway, toolCall(HEALTH), { token: GATEWAY_TOKEN })).status, 200);
  } finally {
    await f.close();
  }
});

test('OAuth works over the unix socket, with the public hostname coming from configuration', async () => {
  const dir = tempDir('tf-oauth-unix-');
  const skillRoot = createSkillRoot();
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const socketPath = path.join(dir, 'bridge.sock');
  const origin = 'https://mcp.example.com';
  const config = bridgeConfig({
    skillRoot,
    daemonSocket: daemon.socket,
    listen: { kind: 'unix', path: socketPath },
    oauth: {
      origin,
      hostname: PUBLIC_HOST,
      resource: `${origin}/mcp`,
      approvalSecret: APPROVAL_SECRET,
      redirects: { exact: [CLAUDE_CALLBACK], loopback: false },
      statePath: path.join(dir, 'oauth.json'),
    },
  });
  const server = createBridge(config);
  const listener = await listenBridge(server, config.listen);
  try {
    const get = (route: string) =>
      send(`${origin}${route}`, '', { socketPath, token: null, method: 'GET' });
    const prm = await get(ROUTE.prmMcp);
    assert.equal(prm.status, 200);
    assert.equal(json(prm).resource, `${origin}/mcp`);

    const refused = await send(`${origin}/mcp`, toolCall(HEALTH), { socketPath, token: null });
    assert.equal(refused.status, 401);
    assert.match(
      String(refused.headers['www-authenticate']),
      /resource_metadata="https:\/\/mcp\.example\.com\//,
    );

    const registered = await send(
      `${origin}/oauth/register`,
      JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }),
      { socketPath, token: null },
    );
    assert.equal(registered.status, 201);
    // Loopback redirects were switched off in this config, so a local callback is refused.
    const local = await send(
      `${origin}/oauth/register`,
      JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/cb'] }),
      { socketPath, token: null },
    );
    assert.equal(local.status, 400);
  } finally {
    await listener.close();
    await daemon.close();
    removeDir(dir);
    removeDir(skillRoot);
  }
});

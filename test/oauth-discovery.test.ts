import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH, fixture, send, toolCall } from './helpers.ts';
import {
  CLAUDE_CALLBACK,
  LOOPBACK_CALLBACK,
  getPage,
  json,
  oauthFixture,
  postForm,
  postJson,
  ROUTE,
  PUBLIC_HOST,
} from './oauth-helpers.ts';

test('without a public URL nothing OAuth-shaped is served and a 401 stays a bare Bearer', async () => {
  const f = await fixture();
  try {
    const base = new URL(f.url).origin;
    for (const route of [ROUTE.prm, ROUTE.prmMcp, ROUTE.metadata, ROUTE.authorize]) {
      assert.equal((await getPage(`${base}${route}`)).status, 404, route);
    }
    assert.equal((await postForm(`${base}/oauth/token`, { grant_type: 'x' })).status, 404);
    const refused = await send(f.url, toolCall(HEALTH), { token: null });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers['www-authenticate'], 'Bearer');
  } finally {
    await f.close();
  }
});

test('a 401 points clients at the protected-resource metadata, and says when a token was bad', async () => {
  const f = await oauthFixture();
  try {
    const metadata = `${f.origin}/.well-known/oauth-protected-resource/mcp`;
    const none = await send(f.mcp, toolCall(HEALTH), { token: null });
    assert.equal(none.status, 401);
    assert.equal(none.headers['www-authenticate'], `Bearer resource_metadata="${metadata}"`);
    assert.equal(none.headers['cache-control'], 'no-store');

    const bad = await send(f.mcp, toolCall(HEALTH), { token: 'not-a-token' });
    assert.equal(bad.status, 401);
    assert.equal(
      bad.headers['www-authenticate'],
      `Bearer resource_metadata="${metadata}", error="invalid_token"`,
    );
    assert.equal(f.daemon.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('the protected-resource metadata names this server and its one authorization server', async () => {
  const f = await oauthFixture();
  try {
    for (const route of [ROUTE.prm, ROUTE.prmMcp]) {
      const sent = await getPage(f.url(route));
      assert.equal(sent.status, 200, route);
      assert.equal(sent.headers['content-type'], 'application/json');
      const body = json(sent);
      // Claude requires `resource` to equal the connector URL exactly.
      assert.equal(body.resource, `${f.origin}/mcp`);
      assert.deepEqual(body.authorization_servers, [f.origin]);
      assert.deepEqual(body.bearer_methods_supported, ['header']);
      assert.ok((body.scopes_supported as string[]).includes('taskferry'));
    }
  } finally {
    await f.close();
  }
});

test('the authorization-server metadata advertises only what is implemented', async () => {
  const f = await oauthFixture();
  try {
    const sent = await getPage(f.url(ROUTE.metadata));
    assert.equal(sent.status, 200);
    const body = json(sent);
    assert.equal(body.issuer, f.origin);
    assert.equal(body.authorization_endpoint, `${f.origin}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${f.origin}/oauth/token`);
    assert.equal(body.registration_endpoint, `${f.origin}/oauth/register`);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(body.response_types_supported, ['code']);
    assert.deepEqual(body.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    assert.equal(sent.headers['access-control-allow-origin'], '*');
  } finally {
    await f.close();
  }
});

test('discovery documents answer CORS preflight, and refuse writes', async () => {
  const f = await oauthFixture();
  try {
    const route = f.url(ROUTE.metadata);
    const preflight = await send(route, '', { token: null, method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    const write = await send(route, '{}', { token: null });
    assert.equal(write.status, 405);
    assert.match(String(write.headers.allow), /GET/);
  } finally {
    await f.close();
  }
});

test('every OAuth response is uncacheable, unframeable and sends no referrer', async () => {
  const f = await oauthFixture();
  try {
    const sent = await getPage(f.url(ROUTE.authorize));
    assert.equal(sent.status, 400);
    assert.equal(sent.headers['cache-control'], 'no-store');
    assert.equal(sent.headers['x-frame-options'], 'DENY');
    assert.equal(sent.headers['x-content-type-options'], 'nosniff');
    assert.equal(sent.headers['referrer-policy'], 'no-referrer');
    assert.match(String(sent.headers['content-security-policy']), /frame-ancestors 'none'/);
  } finally {
    await f.close();
  }
});

test('registration accepts the Claude callback and a loopback redirect', async () => {
  const f = await oauthFixture();
  try {
    const claude = await postJson(f.url(ROUTE.register), {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(claude.status, 201);
    const body = json(claude);
    assert.equal(typeof body.client_id, 'string');
    assert.deepEqual(body.redirect_uris, [CLAUDE_CALLBACK]);
    assert.equal(body.token_endpoint_auth_method, 'none');

    // Claude Code listens on an ephemeral loopback port, so the port is not part of the match.
    const code = await postJson(f.url(ROUTE.register), {
      redirect_uris: [LOOPBACK_CALLBACK, 'http://localhost:1/other'],
    });
    assert.equal(code.status, 201);
  } finally {
    await f.close();
  }
});

test('registration refuses redirects, methods and shapes it does not support', async () => {
  const f = await oauthFixture();
  try {
    const refused = async (body: unknown, error: string) => {
      const sent = await postJson(f.url(ROUTE.register), body);
      assert.equal(sent.status, 400, JSON.stringify(body));
      assert.equal(json(sent).error, error, JSON.stringify(body));
    };
    const ok = { redirect_uris: [CLAUDE_CALLBACK] };
    await refused({ redirect_uris: ['https://evil.example.com/cb'] }, 'invalid_redirect_uri');
    await refused({ redirect_uris: ['http://example.com/cb'] }, 'invalid_redirect_uri');
    await refused({ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri');
    await refused({ redirect_uris: [`${CLAUDE_CALLBACK}#frag`] }, 'invalid_redirect_uri');
    await refused({ redirect_uris: [] }, 'invalid_redirect_uri');
    await refused({}, 'invalid_redirect_uri');
    await refused(
      { ...ok, token_endpoint_auth_method: 'client_secret_basic' },
      'invalid_client_metadata',
    );
    await refused({ ...ok, grant_types: ['implicit'] }, 'invalid_client_metadata');
    await refused({ ...ok, grant_types: ['refresh_token'] }, 'invalid_client_metadata');
    await refused({ ...ok, response_types: ['token'] }, 'invalid_client_metadata');
    await refused([ok], 'invalid_client_metadata');

    const notJson = await send(f.url(ROUTE.register), 'redirect_uris=x', {
      token: null,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(notJson.status, 400);
    const garbage = await send(f.url(ROUTE.register), '{nope', { token: null });
    assert.equal(garbage.status, 400);
    const huge = await postJson(f.url(ROUTE.register), { ...ok, pad: 'x'.repeat(40_000) });
    assert.equal(huge.status, 413);
    const get = await getPage(f.url(ROUTE.register));
    assert.equal(get.status, 405);
  } finally {
    await f.close();
  }
});

test('a registered client name cannot carry markup or control characters', async () => {
  const f = await oauthFixture();
  try {
    const sent = await postJson(f.url(ROUTE.register), {
      client_name: '<b>Ev\u202eil</b>\u0000\nName',
      redirect_uris: [CLAUDE_CALLBACK],
    });
    assert.equal(sent.status, 201);
    const name = json(sent).client_name as string;
    const unsafe = [...name].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x202e;
    });
    assert.ok(!unsafe, JSON.stringify(name));
    assert.ok(name.length <= 100);
  } finally {
    await f.close();
  }
});

test('on loopback TCP the OAuth endpoints keep the rebinding guard, plus the public hostname', async () => {
  const f = await oauthFixture({ hostname: PUBLIC_HOST });
  try {
    const route = f.url(ROUTE.metadata);
    const get = (host: string) =>
      send(route, '', { token: null, method: 'GET', headers: { host } });
    assert.equal((await get('evil.example.com')).status, 403);
    assert.equal((await get(PUBLIC_HOST)).status, 200);
    assert.equal((await get('127.0.0.1')).status, 200);

    // A tunnel forwards the public hostname to /mcp as well, so it must pass there too.
    const viaTunnel = await send(f.mcp, toolCall(HEALTH), { headers: { host: PUBLIC_HOST } });
    assert.equal(viaTunnel.status, 200);
    const rebound = await send(f.mcp, toolCall(HEALTH), { headers: { host: 'evil.example.com' } });
    assert.equal(rebound.status, 403);
    const foreignOrigin = await send(f.mcp, toolCall(HEALTH), {
      headers: { host: PUBLIC_HOST, origin: 'https://evil.example.com' },
    });
    assert.equal(foreignOrigin.status, 403);
  } finally {
    await f.close();
  }
});

test('the static bearer token keeps working beside OAuth', async () => {
  const f = await oauthFixture();
  try {
    const ok = await send(f.mcp, toolCall(HEALTH));
    assert.equal(ok.status, 200);
    assert.equal(f.daemon.calls.length, 1);
  } finally {
    await f.close();
  }
});

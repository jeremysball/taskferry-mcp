import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_CODES } from '../src/oauth-store.ts';
import { HEALTH, send, toolCall, type Sent } from './helpers.ts';

const INVALID_REQUEST = 'invalid_request';
const OTHER_RESOURCE = 'https://other.example.com/mcp';
import {
  APPROVAL_SECRET,
  CLAUDE_CALLBACK,
  approve,
  authorizeUrl,
  exchange,
  getPage,
  json,
  location,
  mcpHealth,
  oauthFixture,
  pkce,
  postForm,
  refresh,
  registerClient,
  requestId,
  type OAuthFixture,
  ROUTE,
} from './oauth-helpers.ts';

test('the full sign-in: register, approve, exchange, call MCP, refresh', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f, { state: 'xyz' });
    const tokens = await exchange(f, signIn);
    assert.equal(tokens.status, 200);
    assert.equal(tokens.headers['cache-control'], 'no-store');
    const body = json(tokens);
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 3600);
    assert.equal(body.scope, 'taskferry');
    assert.equal(typeof body.refresh_token, 'string');

    const call = await mcpHealth(f, body.access_token as string);
    assert.equal(call.status, 200);
    assert.equal(f.daemon.calls.length, 1);

    const next = await refresh(f, signIn.clientId, body.refresh_token as string);
    assert.equal(next.status, 200);
    const rotated = json(next);
    assert.notEqual(rotated.refresh_token, body.refresh_token);
    assert.equal((await mcpHealth(f, rotated.access_token as string)).status, 200);
  } finally {
    await f.close();
  }
});

test('the redirect carries the code, the caller state and the issuer', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f);
    const { challenge } = pkce();
    const page = await getPage(
      authorizeUrl(f, {
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'a state with spaces&symbols',
      }),
    );
    assert.equal(page.status, 200);
    assert.match(page.text, /Test client/);
    assert.match(page.text, /claude\.ai/);
    const decided = await postForm(f.url(ROUTE.authorize), {
      request_id: requestId(page.text) ?? '',
      decision: 'approve',
      secret: APPROVAL_SECRET,
    });
    assert.equal(decided.status, 302);
    const target = location(decided);
    assert.equal(`${target.origin}${target.pathname}`, CLAUDE_CALLBACK);
    assert.equal(target.searchParams.get('state'), 'a state with spaces&symbols');
    assert.equal(target.searchParams.get('iss'), f.origin);
    assert.ok(target.searchParams.get('code'));
  } finally {
    await f.close();
  }
});

test('the consent page escapes the client name and shows where the code will go', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f, { client_name: '"><script>alert(1)</script>' });
    const page = await getPage(
      authorizeUrl(f, {
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        response_type: 'code',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );
    assert.ok(!page.text.includes('<script>alert'));
    assert.match(page.text, /&lt;script&gt;/);
    assert.match(page.text, /read any file/);
  } finally {
    await f.close();
  }
});

async function consent(f: OAuthFixture, params: Record<string, string> = {}) {
  const clientId = await registerClient(f);
  return getPage(
    authorizeUrl(f, {
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 's',
      ...params,
    }),
  );
}

test('a bad authorization request is bounced to the client with an error, state and issuer', async () => {
  const f = await oauthFixture();
  try {
    const cases: [Record<string, string>, string][] = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, INVALID_REQUEST],
      [{ code_challenge: 'short' }, INVALID_REQUEST],
      [{ resource: OTHER_RESOURCE }, 'invalid_target'],
      [{ scope: 'taskferry admin' }, 'invalid_scope'],
      [{ scope: 'offline_access' }, 'invalid_scope'],
    ];
    for (const [params, error] of cases) {
      const sent = await consent(f, params);
      assert.equal(sent.status, 302, JSON.stringify(params));
      const target = location(sent);
      assert.equal(target.searchParams.get('error'), error, JSON.stringify(params));
      assert.equal(target.searchParams.get('state'), 's');
      assert.equal(target.searchParams.get('iss'), f.origin);
      assert.equal(target.searchParams.get('code'), null);
    }
    // A request with no PKCE at all is refused the same way.
    const clientId = await registerClient(f);
    const bare = await getPage(
      authorizeUrl(f, {
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        response_type: 'code',
      }),
    );
    assert.equal(location(bare).searchParams.get('error'), INVALID_REQUEST);
  } finally {
    await f.close();
  }
});

test('an unknown client or unregistered redirect is shown an error, never redirected', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f);
    const pair = { code_challenge: pkce().challenge, code_challenge_method: 'S256' };
    const attempts: Record<string, string>[] = [
      { client_id: 'nobody', redirect_uri: CLAUDE_CALLBACK },
      { client_id: clientId, redirect_uri: 'https://evil.example.com/cb' },
      { client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback/' },
      { client_id: clientId },
      { redirect_uri: CLAUDE_CALLBACK },
    ];
    for (const attempt of attempts) {
      const sent = await getPage(authorizeUrl(f, { response_type: 'code', ...pair, ...attempt }));
      assert.equal(sent.status, 400, JSON.stringify(attempt));
      assert.equal(sent.headers.location, undefined, JSON.stringify(attempt));
    }
    // A repeated parameter is ambiguous and counts as missing.
    const url = new URL(authorizeUrl(f, { client_id: clientId, response_type: 'code', ...pair }));
    url.searchParams.append('redirect_uri', CLAUDE_CALLBACK);
    url.searchParams.append('redirect_uri', 'https://evil.example.com/cb');
    assert.equal((await getPage(url.href)).status, 400);
  } finally {
    await f.close();
  }
});

test('the owner can deny, and the request is spent', async () => {
  const f = await oauthFixture();
  try {
    const page = await consent(f);
    const id = requestId(page.text) ?? '';
    const denied = await postForm(f.url(ROUTE.authorize), { request_id: id, decision: 'deny' });
    assert.equal(denied.status, 302);
    assert.equal(location(denied).searchParams.get('error'), 'access_denied');
    assert.equal(location(denied).searchParams.get('state'), 's');
    const again = await postForm(f.url(ROUTE.authorize), {
      request_id: id,
      decision: 'approve',
      secret: APPROVAL_SECRET,
    });
    assert.equal(again.status, 400);
    assert.equal(again.headers.location, undefined);
  } finally {
    await f.close();
  }
});

test('a wrong secret re-shows the page and keeps the request open; the right one then works', async () => {
  const f = await oauthFixture();
  try {
    const id = requestId((await consent(f)).text) ?? '';
    const wrong = await postForm(f.url(ROUTE.authorize), {
      request_id: id,
      decision: 'approve',
      secret: 'guess',
    });
    assert.equal(wrong.status, 403);
    assert.match(wrong.text, /not the approval secret/);
    assert.equal(requestId(wrong.text), id);
    assert.ok(!wrong.text.includes(APPROVAL_SECRET));
    const right = await postForm(f.url(ROUTE.authorize), {
      request_id: id,
      decision: 'approve',
      secret: APPROVAL_SECRET,
    });
    assert.ok(location(right).searchParams.get('code'));
  } finally {
    await f.close();
  }
});

test('repeated wrong secrets lock approval out, even for the right secret', async () => {
  const f = await oauthFixture();
  try {
    const id = requestId((await consent(f)).text) ?? '';
    const attempt = (secret: string) =>
      postForm(f.url(ROUTE.authorize), { request_id: id, decision: 'approve', secret });
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt('guess')).status, 403);
    const locked = await attempt(APPROVAL_SECRET);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers['retry-after']) > 0);
    assert.equal(locked.headers.location, undefined);
    // Denying never needs the secret, so a lockout cannot trap the owner.
    const denied = await postForm(f.url(ROUTE.authorize), { request_id: id, decision: 'deny' });
    assert.equal(denied.status, 302);
  } finally {
    await f.close();
  }
});

test('the approval POST refuses other content types and oversized bodies', async () => {
  const f = await oauthFixture();
  try {
    const json415 = await send(f.url(ROUTE.authorize), '{}', { token: null });
    assert.equal(json415.status, 415);
    const huge = await postForm(f.url(ROUTE.authorize), { request_id: 'x'.repeat(40_000) });
    assert.equal(huge.status, 413);
    const put = await send(f.url(ROUTE.authorize), '', { token: null, method: 'PUT' });
    assert.equal(put.status, 405);
  } finally {
    await f.close();
  }
});

test('the token endpoint binds a code to its PKCE verifier, client and redirect', async () => {
  const f = await oauthFixture();
  try {
    const wrongVerifier = await approve(f);
    const bad = await exchange(f, wrongVerifier, { code_verifier: pkce().verifier });
    assert.equal(bad.status, 400);
    assert.equal(json(bad).error, 'invalid_grant');
    // The failed attempt spent the code: the right verifier no longer helps.
    assert.equal(json(await exchange(f, wrongVerifier)).error, 'invalid_grant');

    const wrongRedirect = await approve(f);
    const moved = await exchange(f, wrongRedirect, { redirect_uri: 'http://127.0.0.1:1/cb' });
    assert.equal(json(moved).error, 'invalid_grant');

    const stolen = await approve(f);
    const otherClient = await registerClient(f);
    const theft = await exchange(f, stolen, { client_id: otherClient });
    assert.equal(json(theft).error, 'invalid_grant');
  } finally {
    await f.close();
  }
});

test('replaying a spent code is refused and revokes the tokens it produced', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const first = json(await exchange(f, signIn));
    assert.equal((await mcpHealth(f, first.access_token as string)).status, 200);

    const replay = await exchange(f, signIn);
    assert.equal(json(replay).error, 'invalid_grant');
    assert.equal((await mcpHealth(f, first.access_token as string)).status, 401);
    const dead = await refresh(f, signIn.clientId, first.refresh_token as string);
    assert.equal(json(dead).error, 'invalid_grant');
  } finally {
    await f.close();
  }
});

test('reusing a rotated refresh token revokes every token in the family', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const first = json(await exchange(f, signIn));
    const second = json(await refresh(f, signIn.clientId, first.refresh_token as string));
    assert.equal((await mcpHealth(f, second.access_token as string)).status, 200);

    const stolen = await refresh(f, signIn.clientId, first.refresh_token as string);
    assert.equal(stolen.status, 400);
    assert.equal(json(stolen).error, 'invalid_grant');
    assert.equal((await mcpHealth(f, second.access_token as string)).status, 401);
    const fresh = await refresh(f, signIn.clientId, second.refresh_token as string);
    assert.equal(json(fresh).error, 'invalid_grant');
  } finally {
    await f.close();
  }
});

test('token endpoint errors use the OAuth error codes', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const token = (fields: Record<string, string>) => postForm(f.url(ROUTE.token), fields);
    const error = async (sent: Promise<Sent>) => json(await sent).error;

    assert.equal(
      await error(token({ grant_type: 'password', client_id: signIn.clientId })),
      'unsupported_grant_type',
    );
    assert.equal(
      await error(token({ grant_type: 'authorization_code', client_id: 'nobody' })),
      'invalid_client',
    );
    assert.equal(await error(token({ grant_type: 'authorization_code' })), 'invalid_client');
    assert.equal(
      await error(
        token({ grant_type: 'authorization_code', client_id: signIn.clientId, code: 'x' }),
      ),
      INVALID_REQUEST,
    );
    assert.equal(
      await error(
        token({
          grant_type: 'authorization_code',
          client_id: signIn.clientId,
          code: 'x',
          redirect_uri: signIn.redirectUri,
          code_verifier: 'too-short',
        }),
      ),
      INVALID_REQUEST,
    );
    assert.equal(await error(exchange(f, signIn, { resource: OTHER_RESOURCE })), 'invalid_target');
    assert.equal(
      await error(refresh(f, signIn.clientId, 'not-a-token', { scope: 'taskferry admin' })),
      'invalid_scope',
    );
    assert.equal(await error(refresh(f, signIn.clientId, 'not-a-token')), 'invalid_grant');

    const asJson = await send(f.url(ROUTE.token), '{}', { token: null });
    assert.equal(asJson.status, 400);
    assert.equal(json(asJson).error, INVALID_REQUEST);
    assert.equal((await getPage(f.url(ROUTE.token))).status, 405);
  } finally {
    await f.close();
  }
});

test('revocation kills the grant, and always answers 200', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const tokens = json(await exchange(f, signIn));
    const revoke = (token: string, clientId = signIn.clientId) =>
      postForm(f.url(ROUTE.revoke), { token, client_id: clientId });

    assert.equal((await revoke('unknown')).status, 200);
    const other = await registerClient(f);
    assert.equal((await revoke(tokens.refresh_token as string, other)).status, 200);
    assert.equal((await mcpHealth(f, tokens.access_token as string)).status, 200);

    assert.equal((await revoke(tokens.refresh_token as string)).status, 200);
    assert.equal((await mcpHealth(f, tokens.access_token as string)).status, 401);
    const dead = await refresh(f, signIn.clientId, tokens.refresh_token as string);
    assert.equal(json(dead).error, 'invalid_grant');
    assert.equal(
      (await postForm(f.url(ROUTE.revoke), { token: 'x', client_id: 'nobody' })).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('an access token only opens /mcp, and other credentials do not become tokens', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const tokens = json(await exchange(f, signIn));
    const access = tokens.access_token as string;
    // The refresh token and the approval secret are not bearer credentials for MCP.
    assert.equal((await mcpHealth(f, tokens.refresh_token as string)).status, 401);
    assert.equal((await mcpHealth(f, APPROVAL_SECRET)).status, 401);
    assert.equal((await mcpHealth(f, signIn.code)).status, 401);
    // And the access token still has to satisfy the rest of the transport.
    const get = await send(f.mcp, '', { token: access, method: 'GET' });
    assert.equal(get.status, 405);
    const plain = await send(f.mcp, toolCall(HEALTH), {
      token: access,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.status, 415);
  } finally {
    await f.close();
  }
});

test('the state file holds neither tokens nor the approval secret', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const tokens = json(await exchange(f, signIn));
    const text = readFileSync(f.oauth.statePath, 'utf8');
    assert.ok(!text.includes(tokens.refresh_token as string));
    assert.ok(!text.includes(tokens.access_token as string));
    assert.ok(!text.includes(APPROVAL_SECRET));
  } finally {
    await f.close();
  }
});

test('tightening the redirect allowlist retires a redirect registered earlier', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f);
    const { challenge } = pkce();
    const url = authorizeUrl(f, {
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    f.oauth.redirects.exact.length = 0;
    const page = await getPage(url);
    assert.equal(page.status, 400);
    assert.equal(page.headers.location, undefined);
  } finally {
    await f.close();
  }
});

test('a repeated token parameter is refused instead of treated as absent', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: signIn.clientId,
      code: signIn.code,
      code_verifier: signIn.verifier,
      redirect_uri: signIn.redirectUri,
      resource: f.oauth.resource,
    }).toString();
    const sent = await send(
      `${f.url(ROUTE.token)}?`,
      `${body}&resource=${encodeURIComponent(f.oauth.resource)}`,
      {
        token: null,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
    );
    assert.equal(sent.status, 400);
  } finally {
    await f.close();
  }
});

test('approval at the code cap keeps the pending request instead of losing the sign-in', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f);
    const { challenge } = pkce();
    const consent = () =>
      getPage(
        authorizeUrl(f, {
          client_id: clientId,
          redirect_uri: CLAUDE_CALLBACK,
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      );
    for (let i = 0; i < MAX_CODES; i += 1) {
      const id = requestId((await consent()).text);
      const decided = await postForm(f.url(ROUTE.authorize), {
        request_id: id as string,
        decision: 'approve',
        secret: APPROVAL_SECRET,
      });
      assert.equal(decided.status, 302);
    }
    const id = requestId((await consent()).text) as string;
    const full = await postForm(f.url(ROUTE.authorize), {
      request_id: id,
      decision: 'approve',
      secret: APPROVAL_SECRET,
    });
    assert.equal(full.status, 503);
    // The owner can retry the same request; nothing was consumed.
    assert.equal(requestId(full.text), id);
    const retry = await postForm(f.url(ROUTE.authorize), {
      request_id: id,
      decision: 'approve',
      secret: APPROVAL_SECRET,
    });
    assert.equal(retry.status, 503);
  } finally {
    await f.close();
  }
});

test('a code issued before the resource changed cannot mint a token for the new one', async () => {
  const f = await oauthFixture();
  try {
    const signIn = await approve(f);
    f.oauth.resource = OTHER_RESOURCE;
    const sent = await exchange(f, signIn);
    assert.equal(sent.status, 400);
    assert.equal(json(sent).error, 'invalid_grant');
  } finally {
    await f.close();
  }
});

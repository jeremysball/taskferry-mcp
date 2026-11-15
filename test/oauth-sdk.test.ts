import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { HEALTH } from './helpers.ts';
import {
  APPROVAL_SECRET,
  LOOPBACK_CALLBACK,
  getPage,
  location,
  oauthFixture,
  postForm,
  requestId,
  type OAuthFixture,
  ROUTE,
} from './oauth-helpers.ts';

// An in-memory client in the shape every MCP SDK client uses. It is the independent half of this
// test: discovery, registration, PKCE, the redirect and the token exchange are all the SDK's.
class MemoryProvider implements OAuthClientProvider {
  clientInfo: StoredOAuthClientInformation | undefined;
  stored: StoredOAuthTokens | undefined;
  verifier = '';
  discovery: OAuthDiscoveryState | undefined;
  expectedState = '';
  redirected: URL | null = null;

  get redirectUrl() {
    return LOOPBACK_CALLBACK;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK test client',
      redirect_uris: [LOOPBACK_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    this.expectedState = randomBytes(12).toString('base64url');
    return this.expectedState;
  }

  clientInformation() {
    return this.clientInfo;
  }

  saveClientInformation(info: StoredOAuthClientInformation) {
    this.clientInfo = info;
  }

  tokens() {
    return this.stored;
  }

  saveTokens(tokens: StoredOAuthTokens) {
    this.stored = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.redirected = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }

  discoveryState() {
    return this.discovery;
  }
}

const connect = async (f: OAuthFixture, provider: MemoryProvider) => {
  const transport = new StreamableHTTPClientTransport(new URL(f.mcp), { authProvider: provider });
  const client = new Client({ name: 'sdk-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
};

// The owner's side: open the URL the client was sent to and approve it with the secret.
async function approveRedirect(f: OAuthFixture, authorization: URL) {
  const page = await getPage(authorization.href);
  assert.equal(page.status, 200, page.text);
  const decided = await postForm(f.url(ROUTE.authorize), {
    request_id: requestId(page.text) ?? '',
    decision: 'approve',
    secret: APPROVAL_SECRET,
  });
  assert.equal(decided.status, 302);
  return location(decided);
}

test('the MCP SDK client signs in end to end and then calls a tool', async () => {
  const f = await oauthFixture();
  try {
    const provider = new MemoryProvider();
    const first = new StreamableHTTPClientTransport(new URL(f.mcp), { authProvider: provider });
    await assert.rejects(new Client({ name: 'sdk-test', version: '0.0.0' }).connect(first));
    assert.ok(provider.redirected, 'the client was sent to the authorization endpoint');
    assert.equal(provider.redirected.origin, f.origin);
    assert.equal(provider.redirected.searchParams.get('resource'), f.oauth.resource);
    assert.equal(provider.redirected.searchParams.get('code_challenge_method'), 'S256');

    const callback = await approveRedirect(f, provider.redirected);
    assert.equal(callback.searchParams.get('state'), provider.expectedState);
    await first.finishAuth(callback.searchParams);
    assert.ok(provider.stored?.access_token);

    const { client } = await connect(f, provider);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === HEALTH));
    const result = await client.callTool({ name: HEALTH, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(f.daemon.calls.length >= 1, true);
    await client.close();
  } finally {
    await f.close();
  }
});

test('the SDK client refreshes a dead access token on its own, without another approval', async () => {
  const f = await oauthFixture();
  try {
    const provider = new MemoryProvider();
    const first = new StreamableHTTPClientTransport(new URL(f.mcp), { authProvider: provider });
    await assert.rejects(new Client({ name: 'sdk-test', version: '0.0.0' }).connect(first));
    const callback = await approveRedirect(f, provider.redirected as URL);
    await first.finishAuth(callback.searchParams);

    const before = provider.stored;
    assert.ok(before?.refresh_token);
    provider.redirected = null;
    provider.stored = { ...before, access_token: 'revoked-or-expired' };

    const { client } = await connect(f, provider);
    assert.equal(provider.redirected, null, 'a refresh must not need the owner again');
    assert.notEqual(provider.stored?.access_token, 'revoked-or-expired');
    assert.notEqual(
      provider.stored?.refresh_token,
      before.refresh_token,
      'the refresh token rotates',
    );
    const result = await client.callTool({ name: HEALTH, arguments: {} });
    assert.notEqual(result.isError, true);
    await client.close();
  } finally {
    await f.close();
  }
});

test('the SDK client refuses a redirect that claims to come from another issuer', async () => {
  const f = await oauthFixture();
  try {
    const provider = new MemoryProvider();
    const transport = new StreamableHTTPClientTransport(new URL(f.mcp), { authProvider: provider });
    await assert.rejects(new Client({ name: 'sdk-test', version: '0.0.0' }).connect(transport));
    const callback = await approveRedirect(f, provider.redirected as URL);
    assert.equal(callback.searchParams.get('iss'), f.origin);

    const forged = new URLSearchParams(callback.searchParams);
    forged.set('iss', 'https://evil.example.com');
    await assert.rejects(transport.finishAuth(forged), /issuer/i);
    assert.equal(provider.stored, undefined);
  } finally {
    await f.close();
  }
});

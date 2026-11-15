import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  CIMD_MAX_BYTES,
  CimdResolver,
  isClientIdUrl,
  parseClientIdUrl,
  type CimdFetch,
} from '../src/oauth-cimd.ts';
import {
  APPROVAL_SECRET,
  CLAUDE_CALLBACK,
  exchange,
  getPage,
  json,
  location,
  oauthFixture,
  pkce,
  postForm,
  registerClient,
  requestId,
  ROUTE,
  type SignIn,
} from './oauth-helpers.ts';
import { createOAuth, type OAuth } from '../src/oauth.ts';
import type { OAuthConfig } from '../src/oauth-config.ts';
import { removeDir, tempDir } from './helpers.ts';

const CLIENT_ID = 'https://client.example.com/oauth/metadata.json';
const RESOURCE = 'https://mcp.example.com/mcp';
const REDIRECTS = { exact: [CLAUDE_CALLBACK], loopback: true };

const doc = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: 'Metadata client',
  redirect_uris: [CLAUDE_CALLBACK],
  ...overrides,
});

// A fetch that answers from a table and counts calls, so caching is visible.
function fakeFetch(
  outcome: (url: string) => Response | Promise<Response>,
): CimdFetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return outcome(url);
  }) as CimdFetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

type ResponseOptions = { status?: number; headers?: Record<string, string> };
const jsonResponse = (body: unknown, init: ResponseOptions = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

function resolver(fetchImpl: CimdFetch, now?: () => number) {
  return new CimdResolver({ redirects: REDIRECTS, log: () => {}, fetch: fetchImpl, now });
}

test('the client id must be an https URL with a path and no dot segments', () => {
  assert.ok(parseClientIdUrl(CLIENT_ID));
  assert.equal(parseClientIdUrl('http://client.example.com/meta.json'), undefined);
  assert.equal(parseClientIdUrl('https://client.example.com/'), undefined);
  assert.equal(parseClientIdUrl('https://client.example.com/a/../meta.json'), undefined);
  assert.equal(parseClientIdUrl('https://user:pass@client.example.com/meta.json'), undefined);
  assert.equal(parseClientIdUrl('https://client.example.com/meta.json#frag'), undefined);
  assert.ok(isClientIdUrl(CLIENT_ID));
});

test('a valid document resolves to a client and is cached', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const resolve = resolver(fetchImpl);
  const client = await resolve.resolve(CLIENT_ID);
  assert.equal(client?.clientName, 'Metadata client');
  assert.deepEqual(client?.redirectUris, [CLAUDE_CALLBACK]);
  await resolve.resolve(CLIENT_ID);
  assert.equal(fetchImpl.calls.length, 1);
});

test('cache lifetime follows max-age and no-store disables it', async () => {
  let now = 0;
  for (const [header, expected] of [
    ['max-age=120', 1],
    ['no-store', 2],
  ] as const) {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(doc(), {
        headers: { 'content-type': 'application/json', 'cache-control': header },
      }),
    );
    const resolve = resolver(fetchImpl, () => now);
    await resolve.resolve(CLIENT_ID);
    now += 60_000;
    await resolve.resolve(CLIENT_ID);
    assert.equal(fetchImpl.calls.length, expected, header);
    now = 0;
  }
});

test('documents that fail any requirement are refused', async () => {
  const cases: [string, Response][] = [
    ['client id mismatch', jsonResponse(doc({ client_id: `${CLIENT_ID}x` }))],
    ['client secret', jsonResponse(doc({ client_secret: 'x' }))],
    ['confidential auth', jsonResponse(doc({ token_endpoint_auth_method: 'client_secret_basic' }))],
    ['grant types', jsonResponse(doc({ grant_types: ['client_credentials'] }))],
    ['response types', jsonResponse(doc({ response_types: ['token'] }))],
    ['no redirects', jsonResponse(doc({ redirect_uris: [] }))],
    ['too many redirects', jsonResponse(doc({ redirect_uris: Array(11).fill(CLAUDE_CALLBACK) }))],
    ['redirect not allowed', jsonResponse(doc({ redirect_uris: ['https://evil.example/cb'] }))],
    ['not json', new Response('<html>', { headers: { 'content-type': 'application/json' } })],
    ['wrong content type', new Response('{}', { headers: { 'content-type': 'text/plain' } })],
    ['not an object', jsonResponse([])],
  ];
  for (const [name, response] of cases) {
    const resolve = resolver(fakeFetch(() => response));
    assert.equal(await resolve.resolve(CLIENT_ID), undefined, name);
  }
});

test('a redirect response, an error status, an oversized body or a private host is refused', async () => {
  const redirect = fakeFetch(
    () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/doc' } }),
  );
  assert.equal(await resolver(redirect).resolve(CLIENT_ID), undefined);

  const failure = fakeFetch(() => new Response('{}', { status: 500 }));
  assert.equal(await resolver(failure).resolve(CLIENT_ID), undefined);

  const oversized = fakeFetch(() => jsonResponse({ ...doc(), pad: 'x'.repeat(CIMD_MAX_BYTES) }));
  assert.equal(await resolver(oversized).resolve(CLIENT_ID), undefined);

  const privateFetch = fakeFetch(() =>
    jsonResponse(doc({ client_id: 'https://127.0.0.1/meta.json' })),
  );
  assert.equal(await resolver(privateFetch).resolve('https://127.0.0.1/meta.json'), undefined);
  assert.equal(privateFetch.calls.length, 0);
  assert.equal(await resolver(privateFetch).resolve('https://localhost/meta.json'), undefined);
  assert.equal(privateFetch.calls.length, 0);
});

test('only redirect URIs the operator allows survive into the client', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(doc({ redirect_uris: [CLAUDE_CALLBACK, 'https://other.example/cb'] })),
  );
  const client = await resolver(fetchImpl).resolve(CLIENT_ID);
  assert.deepEqual(client?.redirectUris, [CLAUDE_CALLBACK]);
});

// A real HTTP surface around createOAuth, with metadata fetched through the injected function.
async function cimdServer(fetchImpl: CimdFetch) {
  const port = 0;
  const stateDir = tempDir('tf-oauth-cimd-');
  const config: OAuthConfig = {
    origin: 'http://127.0.0.1:1',
    hostname: '127.0.0.1',
    resource: RESOURCE,
    approvalSecret: APPROVAL_SECRET,
    redirects: REDIRECTS,
    statePath: path.join(stateDir, 'oauth.json'),
  };
  const oauth: OAuth = createOAuth(config, { fetchClientMetadata: fetchImpl, log: () => {} });
  const server = createServer((req, res) => {
    void oauth.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  config.origin = base;
  config.resource = `${base}/mcp`;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeDir(stateDir);
  };
  return { base, oauth, close };
}

test('a Client ID Metadata Document signs in end to end without registration', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const s = await cimdServer(fetchImpl);
  try {
    const { verifier, challenge } = pkce();
    const url = new URL(`${s.base}${ROUTE.authorize}`);
    for (const [name, value] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'cimd-state',
    })) {
      url.searchParams.set(name, value);
    }
    const page = await getPage(url.href);
    assert.equal(page.status, 200);
    assert.match(page.text, /Metadata client/);
    assert.match(page.text, /client\.example\.com/);
    const id = requestId(page.text);
    assert.ok(id);
    const decided = await postForm(`${s.base}${ROUTE.authorize}`, {
      decision: 'approve',
      request_id: id as string,
      secret: APPROVAL_SECRET,
    });
    assert.equal(decided.status, 302);
    const signIn: SignIn = {
      verifier,
      clientId: CLIENT_ID,
      redirectUri: CLAUDE_CALLBACK,
      code: location(decided).searchParams.get('code') as string,
    };
    const fakeFixture = { url: (route: string) => `${s.base}${route}` } as never;
    const tokens = await exchange(fakeFixture, signIn);
    assert.equal(tokens.status, 200);
    assert.equal(json(tokens).token_type, 'Bearer');
    assert.equal(fetchImpl.calls.length, 1, 'the document is fetched once');
    assert.equal(s.oauth.verify(json(tokens).access_token as string), true);
  } finally {
    await s.close();
  }
});

test('an unknown or private metadata client never gets a redirect', async () => {
  const fetchImpl = fakeFetch(() => new Response('{}', { status: 404 }));
  const s = await cimdServer(fetchImpl);
  try {
    const { challenge } = pkce();
    const url = new URL(`${s.base}${ROUTE.authorize}`);
    for (const [name, value] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(name, value);
    }
    const page = await getPage(url.href);
    assert.equal(page.status, 400);
    assert.equal(page.headers.location, undefined);
  } finally {
    await s.close();
  }
});

test('a repeated authorization parameter is refused', async () => {
  const f = await oauthFixture();
  try {
    const clientId = await registerClient(f);
    const { challenge } = pkce();
    const url = new URL(f.url(ROUTE.authorize));
    for (const [name, value] of Object.entries({
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(name, value);
    }
    url.searchParams.append('state', 'a');
    url.searchParams.append('state', 'b');
    const sent = await getPage(url.href);
    assert.equal(sent.status, 302);
    assert.equal(location(sent).searchParams.get('error'), 'invalid_request');
  } finally {
    await f.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
} from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { brotliCompressSync, deflateRawSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  CIMD_MAX_BYTES,
  CIMD_MAX_INFLIGHT,
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
const JSON_TYPE = 'application/json';
const CLIENT_NAME = 'Metadata client';
const REDIRECTS = { exact: [CLAUDE_CALLBACK], loopback: true };
// These simulated DNS answers are never contacted; test connections use loopback instead.
// eslint-disable-next-line sonarjs/no-hardcoded-ip
const PUBLIC_FIRST = '8.8.8.8';
// eslint-disable-next-line sonarjs/no-hardcoded-ip
const PUBLIC_SECOND = '1.1.1.1';

test('metadata host resolving to loopback never opens a connection', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': JSON_TYPE });
    response.end(JSON.stringify(doc()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  let records = [{ address: PUBLIC_FIRST, family: 4 }];
  dns.lookup = (async () => records) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  https.request = ((options: https.RequestOptions, callback: (response: IncomingMessage) => void) =>
    httpRequest(
      { hostname: '127.0.0.1', port: address.port, path: options.path },
      callback,
    )) as typeof https.request;
  try {
    const resolve = () =>
      new CimdResolver({ redirects: REDIRECTS, log: () => {} }).resolve(CLIENT_ID);
    assert.equal((await resolve())?.clientName, CLIENT_NAME);
    assert.equal(requests, 1);
    for (const privateRecord of [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]) {
      for (const ordered of [
        [{ address: PUBLIC_FIRST, family: 4 }, privateRecord],
        [privateRecord, { address: PUBLIC_FIRST, family: 4 }],
      ]) {
        records = ordered;
        const result = await resolve();
        assert.equal(requests, 1);
        assert.equal(result, undefined);
      }
    }
  } finally {
    https.request = originalRequest;
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const doc = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: CLIENT_NAME,
  redirect_uris: [CLAUDE_CALLBACK],
  ...overrides,
});

test('metadata connects to a second validated address when the first refuses connection', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify(doc()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  let dnsCalls = 0;
  const supplied: string[] = [];
  let socket: import('node:net').Socket | undefined;
  dns.lookup = (async () => {
    dnsCalls++;
    return [
      { address: PUBLIC_FIRST, family: 4 },
      { address: PUBLIC_SECOND, family: 4 },
    ];
  }) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  https.request = ((
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const request = httpRequest(
      {
        hostname: options.hostname,
        port: address.port,
        path: options.path,
        signal: options.signal,
        agent: false,
        ...{ autoSelectFamily: true },
        lookup: ((hostname: string, lookupOptions: unknown, done: (...args: unknown[]) => void) => {
          const lookup = options.lookup as (
            host: string,
            opts: unknown,
            cb: (...args: unknown[]) => void,
          ) => void;
          lookup(hostname, lookupOptions, (error: unknown, result: unknown, family: unknown) => {
            if (error) {
              done(error);
              return;
            }
            const records = Array.isArray(result) ? result : [{ address: result, family }];
            supplied.push(...records.map((record) => record.address));
            const mapped = records.map((record) => ({
              address: record.address === PUBLIC_FIRST ? '127.0.0.2' : '127.0.0.1',
              family: 4,
            }));
            if (Array.isArray(result)) done(null, mapped);
            else done(null, mapped[0].address, 4);
          });
        }) as NonNullable<https.RequestOptions['lookup']>,
      },
      callback,
    );
    request.on('socket', (connectedSocket) => {
      socket = connectedSocket;
    });
    return request;
  }) as typeof https.request;
  try {
    const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
    assert.equal((await client.resolve(CLIENT_ID))?.clientName, CLIENT_NAME);
    assert.deepEqual(supplied, [PUBLIC_FIRST, PUBLIC_SECOND]);
    assert.deepEqual(socket?.autoSelectFamilyAttemptedAddresses, [
      `127.0.0.2:${address.port}`,
      `127.0.0.1:${address.port}`,
    ]);
    assert.equal(dnsCalls, 1);
  } finally {
    https.request = originalRequest;
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('pinned HTTPS uses the resolved address and verifies the original hostname', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cert = execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'bash',
    [
      '-c',
      'openssl req -new -x509 -key <(openssl pkey) -days 1 -subj /CN=client.example.com -addext subjectAltName=DNS:client.example.com',
    ],
    { input: privateKey, encoding: 'utf8' },
  );
  const names: string[] = [];
  const server = https.createServer({ key: privateKey, cert }, (req, res) => {
    names.push(req.headers.host ?? '');
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify(doc({ client_id: `https://${req.headers.host}/metadata.json` })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  const resolved: unknown[] = [];
  const errors: string[] = [];
  const lookups: string[] = [];
  const publicAddress = PUBLIC_FIRST;
  dns.lookup = (async (hostname: string) => {
    lookups.push(hostname);
    return [
      { address: publicAddress, family: 4 },
      { address: PUBLIC_SECOND, family: 4 },
    ];
  }) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  https.request = ((
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const lookup = options.lookup;
    const request = originalRequest(
      {
        ...options,
        ca: cert,
        lookup: ((hostname: string, lookupOptions: unknown, done: (...args: unknown[]) => void) => {
          if (!lookup) {
            done(new Error('missing pinned lookup'));
            return;
          }
          (lookup as (host: string, opts: unknown, cb: (...args: unknown[]) => void) => void)(
            hostname,
            lookupOptions,
            (error: unknown, result: unknown, family: unknown) => {
              resolved.push({ hostname, error, result, family });
              if (error) done(error);
              else if (Array.isArray(result))
                done(
                  null,
                  result.map(() => ({ address: '127.0.0.1', family: 4 })),
                );
              else done(null, '127.0.0.1', 4);
            },
          );
        }) as NonNullable<https.RequestOptions['lookup']>,
      },
      callback,
    );
    request.on('error', (error: Error & { code?: string }) =>
      errors.push(error.code ?? error.name),
    );
    return request;
  }) as typeof https.request;
  try {
    const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
    const host = 'client.example.com';
    const dottedHost = `${host}.`;
    const good = `https://client.example.com:${address.port}/metadata.json`;
    const dotted = `https://client.example.com.:${address.port}/metadata.json`;
    const bad = `https://wrong.example.com:${address.port}/metadata.json`;
    assert.equal((await client.resolve(good))?.clientName, CLIENT_NAME);
    const dottedClient = await client.resolve(dotted);
    assert.deepEqual(lookups, [host, dottedHost]);
    assert.deepEqual(names, [
      `client.example.com:${address.port}`,
      `client.example.com.:${address.port}`,
    ]);
    assert.equal(dottedClient?.clientId, dotted);
    assert.equal(await client.resolve(bad), undefined);
    assert.deepEqual(lookups, [host, dottedHost, 'wrong.example.com']);
    assert.deepEqual(errors, ['ERR_TLS_CERT_ALTNAME_INVALID']);
    assert.equal(resolved.length, 3);
    for (const [index, hostname] of [host, dottedHost, 'wrong.example.com'].entries()) {
      const observation = resolved[index] as {
        hostname: string;
        error: unknown;
        result: unknown;
        family: unknown;
      };
      assert.equal(observation.hostname, hostname);
      assert.equal(observation.error, null);
      assert.ok(
        observation.result === publicAddress ||
          JSON.stringify(observation.result) ===
            JSON.stringify([
              { address: publicAddress, family: 4 },
              { address: PUBLIC_SECOND, family: 4 },
            ]),
      );
    }
  } finally {
    https.request = originalRequest;
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function withMetadataServer(respond: RequestListener, run: () => Promise<void>) {
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  dns.lookup = (async () => [
    { address: PUBLIC_FIRST, family: 4 },
    { address: PUBLIC_SECOND, family: 4 },
  ]) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  https.request = ((options: https.RequestOptions, callback: (response: IncomingMessage) => void) =>
    httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        agent: false,
      },
      callback,
    )) as typeof https.request;
  try {
    await run();
  } finally {
    https.request = originalRequest;
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('an HTTP error response does not retry another address', async () => {
  let requests = 0;
  await withMetadataServer(
    (_req, res) => {
      requests++;
      res.writeHead(503);
      res.end();
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal(await client.resolve(CLIENT_ID), undefined);
      assert.equal(requests, 1);
    },
  );
});

test('invalid metadata response status is rejected without an uncaught exception', async () => {
  await withMetadataServer(
    (_req, res) => {
      res.writeHead(999);
      res.end();
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal(await client.resolve(CLIENT_ID), undefined);
    },
  );
});

test('preserves an empty query in the metadata request target', async () => {
  const clientId = `${CLIENT_ID}?`;
  await withMetadataServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify(doc({ client_id: `https://client.example.com${req.url}` })));
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal((await client.resolve(clientId))?.clientName, CLIENT_NAME);
    },
  );
});

test('unexpected protocol upgrade settles metadata resolution', async () => {
  await withMetadataServer(
    (_req, res) => {
      res.writeHead(101, { connection: 'Upgrade', upgrade: 'test' });
      res.flushHeaders();
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      const result = await Promise.race([
        client.resolve(CLIENT_ID).then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('stuck'), 200)),
      ]);
      assert.equal(result, 'settled');
    },
  );
});

test('refused 205 response closes an unfinished connection promptly', async () => {
  let closeResponse: (() => void) | undefined;
  let closed = false;
  await withMetadataServer(
    (_req, res) => {
      closeResponse = () => res.destroy();
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(205, { 'transfer-encoding': 'chunked' });
      res.flushHeaders();
    },
    async () => {
      try {
        const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
        assert.equal(await client.resolve(CLIENT_ID), undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(closed, true);
      } finally {
        closeResponse?.();
      }
    },
  );
});

test('rejects excessively nested content encodings', async () => {
  let body = Buffer.from(JSON.stringify(doc()));
  for (let i = 0; i < 4; i++) body = gzipSync(body);
  await withMetadataServer(
    (_req, res) => {
      res.writeHead(200, {
        'content-type': JSON_TYPE,
        'content-encoding': 'gzip, gzip, gzip, gzip',
      });
      res.end(body);
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal(await client.resolve(CLIENT_ID), undefined);
    },
  );
});

test('gzip encoded metadata is decoded before validation', async () => {
  await withMetadataServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify(doc())));
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal((await client.resolve(CLIENT_ID))?.clientName, CLIENT_NAME);
    },
  );
});

for (const [name, encoding, compress] of [
  ['stacked', 'gzip, br', (data: Buffer) => brotliCompressSync(gzipSync(data))],
  ['raw deflate', 'deflate', (data: Buffer) => deflateRawSync(data)],
] as const) {
  test(`${name} encoded metadata is decoded before validation`, async () => {
    await withMetadataServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': encoding });
        res.end(compress(Buffer.from(JSON.stringify(doc()))));
      },
      async () => {
        const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
        assert.equal((await client.resolve(CLIENT_ID))?.clientName, CLIENT_NAME);
      },
    );
  });
}

test('rejects oversized intermediate decompression output', async () => {
  const emptyMember = gzipSync(Buffer.alloc(0));
  const intermediate = Buffer.concat([
    ...Array.from({ length: 300 }, () => emptyMember),
    gzipSync(JSON.stringify(doc())),
  ]);
  assert.ok(intermediate.length > CIMD_MAX_BYTES);
  await withMetadataServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'gzip, gzip' });
      res.end(gzipSync(intermediate));
    },
    async () => {
      const client = new CimdResolver({ redirects: REDIRECTS, log: () => {} });
      assert.equal(await client.resolve(CLIENT_ID), undefined);
    },
  );
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
    headers: { 'content-type': JSON_TYPE, ...init.headers },
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

test('percent-encoded dot segments are dot segments', () => {
  for (const path of ['%2e%2e', '%2E%2E', '%2e', '%2e%2e%2fmeta.json', 'a%2fb']) {
    const id = `https://client.example.com/${path}/meta.json`;
    assert.equal(parseClientIdUrl(id), undefined, path);
  }
  assert.ok(parseClientIdUrl('https://client.example.com/meta%2ejson'));
});

test('a valid document resolves to a client and is cached', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const resolve = resolver(fetchImpl);
  const client = await resolve.resolve(CLIENT_ID);
  assert.equal(client?.clientName, CLIENT_NAME);
  assert.deepEqual(client?.redirectUris, [CLAUDE_CALLBACK]);
  await resolve.resolve(CLIENT_ID);
  assert.equal(fetchImpl.calls.length, 1);
});

test('cache lifetime follows max-age and no-store disables it', async () => {
  let now = 0;
  for (const [header, expected] of [
    ['max-age=120', 1],
    ['max-age="120"', 1],
    ['no-store', 2],
    ['no-cache', 2],
    ['max-age=oops', 2],
    ['max-age=0', 2],
  ] as const) {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(doc(), {
        headers: { 'content-type': JSON_TYPE, 'cache-control': header },
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
    ['extra response types', jsonResponse(doc({ response_types: ['code', 'token'] }))],
    ['empty response types', jsonResponse(doc({ response_types: [] }))],
    ['no redirects', jsonResponse(doc({ redirect_uris: [] }))],
    ['too many redirects', jsonResponse(doc({ redirect_uris: Array(11).fill(CLAUDE_CALLBACK) }))],
    ['redirect not allowed', jsonResponse(doc({ redirect_uris: ['https://evil.example/cb'] }))],
    ['not json', new Response('<html>', { headers: { 'content-type': JSON_TYPE } })],
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

test('a document with only an over-long redirect URI is refused', async () => {
  const long = `https://client.example.com/${'a'.repeat(2048)}`;
  const resolve = new CimdResolver({
    redirects: { exact: [long], loopback: false },
    log: () => {},
    fetch: fakeFetch(() => jsonResponse(doc({ redirect_uris: [long] }))),
  });
  assert.equal(await resolve.resolve(CLIENT_ID), undefined);
});

test('IPv6, IPv4 and trailing-dot local hosts are refused before any fetch', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const resolve = resolver(fetchImpl);
  for (const id of [
    'https://[::1]/meta.json',
    'https://[fe80::1]/meta.json',
    'https://192.168.1.10/meta.json',
    'https://8.8.8.8/meta.json',
    'https://localhost./meta.json',
    'https://router.local./meta.json',
  ]) {
    assert.equal(await resolve.resolve(id), undefined, id);
  }
  assert.deepEqual(fetchImpl.calls, []);
});

test('a body that fails mid-stream is refused without throwing', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"client_id":'));
      controller.error(new Error('connection reset'));
    },
  });
  const fetchImpl = fakeFetch(
    () => new Response(stream, { headers: { 'content-type': JSON_TYPE } }),
  );
  assert.equal(await resolver(fetchImpl).resolve(CLIENT_ID), undefined);
});

test('a refused response has its body cancelled', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = fakeFetch(() => new Response(stream, { status: 500 }));
  assert.equal(await resolver(fetchImpl).resolve(CLIENT_ID), undefined);
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
});

test('concurrent sign-ins for one document share a single fetch', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = fakeFetch(async () => {
    await gate;
    return jsonResponse(doc());
  });
  const resolve = resolver(fetchImpl);
  const both = Promise.all([resolve.resolve(CLIENT_ID), resolve.resolve(CLIENT_ID)]);
  await new Promise((done) => setImmediate(done));
  assert.equal(fetchImpl.calls.length, 1);
  release();
  const [first, second] = await both;
  assert.equal(first?.clientName, CLIENT_NAME);
  assert.deepEqual(second, first);
});

test('a burst of distinct documents is bounded while fetches are in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = fakeFetch(async (input) => {
    const url = String(input);
    await gate;
    return jsonResponse(doc({ client_id: url }));
  });
  const resolve = resolver(fetchImpl);
  const ids = Array.from(
    { length: CIMD_MAX_INFLIGHT + 1 },
    (_, index) => `https://client.example.com/meta-${index}.json`,
  );
  const pending = ids.map((id) => resolve.resolve(id));
  await new Promise((done) => setImmediate(done));
  assert.equal(fetchImpl.calls.length, CIMD_MAX_INFLIGHT);
  release();
  const results = await Promise.all(pending);
  assert.equal(results.filter((client) => client !== undefined).length, CIMD_MAX_INFLIGHT);
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

async function approveCimd(base: string): Promise<SignIn> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${base}${ROUTE.authorize}`);
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
  const decided = await postForm(`${base}${ROUTE.authorize}`, {
    decision: 'approve',
    request_id: id as string,
    secret: APPROVAL_SECRET,
  });
  assert.equal(decided.status, 302);
  return {
    verifier,
    clientId: CLIENT_ID,
    redirectUri: CLAUDE_CALLBACK,
    code: location(decided).searchParams.get('code') as string,
  };
}

test('a Client ID Metadata Document signs in end to end without registration', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const s = await cimdServer(fetchImpl);
  try {
    const signIn = await approveCimd(s.base);
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

test('token exchange, refresh and revocation do not need the metadata host', async () => {
  let up = true;
  const fetchImpl = fakeFetch(() => (up ? jsonResponse(doc()) : new Response('', { status: 503 })));
  const s = await cimdServer(fetchImpl);
  try {
    const signIn = await approveCimd(s.base);
    up = false;
    const fakeFixture = { url: (route: string) => `${s.base}${route}` } as never;
    const tokens = await exchange(fakeFixture, signIn);
    assert.equal(tokens.status, 200);
    const refreshed = await postForm(`${s.base}${ROUTE.token}`, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: json(tokens).refresh_token as string,
    });
    assert.equal(refreshed.status, 200);
    const revoked = await postForm(`${s.base}${ROUTE.revoke}`, {
      token: json(refreshed).refresh_token as string,
      client_id: CLIENT_ID,
    });
    assert.equal(revoked.status, 200);
    assert.equal(fetchImpl.calls.length, 1, 'no token or revocation request fetched metadata');
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

test('a disallowed redirect is refused before any metadata fetch', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(doc()));
  const s = await cimdServer(fetchImpl);
  try {
    const { challenge } = pkce();
    const url = new URL(`${s.base}${ROUTE.authorize}`);
    for (const [name, value] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: 'https://evil.example/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(name, value);
    }
    const page = await getPage(url.href);
    assert.equal(page.status, 400);
    assert.deepEqual(fetchImpl.calls, []);
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

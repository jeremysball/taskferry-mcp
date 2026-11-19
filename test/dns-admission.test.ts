import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { CimdResolver } from '../src/oauth-cimd.ts';
import { CallbackError, postCallback, resolveCallbackTarget } from '../src/webhook.ts';

// The simulated DNS answer is never contacted.
// eslint-disable-next-line sonarjs/no-hardcoded-ip
const PUBLIC_ADDRESS = '8.8.8.8';

test('more than eight concurrent webhook lookups reach DNS and resolve public answers', async () => {
  const original = dns.lookup;
  const pending: Array<(value: { address: string; family: number }[]) => void> = [];
  dns.lookup = (() => new Promise((resolve) => pending.push(resolve))) as typeof dns.lookup;
  syncBuiltinESMExports();
  let results: Promise<PromiseSettledResult<Awaited<ReturnType<typeof resolveCallbackTarget>>>[]>;
  try {
    const targets = Array.from({ length: 12 }, (_, i) =>
      resolveCallbackTarget(`https://webhook${i}.example.com/`),
    );
    results = Promise.allSettled(targets);
    assert.equal(pending.length, 12, 'all webhook lookups must reach DNS');
    for (const resolve of pending) resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    const settled = await results;
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 12);
    for (const result of settled) {
      assert.equal(result.status === 'fulfilled' && result.value.address, PUBLIC_ADDRESS);
    }
  } finally {
    for (const resolve of pending) resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    await results!;
    dns.lookup = original;
    syncBuiltinESMExports();
  }
});

test('CIMD lookups held past timeout do not consume webhook admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = dns.lookup;
  const pending: Array<(value: { address: string; family: number }[]) => void> = [];
  dns.lookup = (() => new Promise((resolve) => pending.push(resolve))) as typeof dns.lookup;
  syncBuiltinESMExports();
  const cimd = new CimdResolver({ redirects: { exact: [], loopback: false }, log: () => {} });
  try {
    const clients = Array.from({ length: 8 }, (_, i) =>
      cimd.resolve(`https://client${i}.example.com/metadata`),
    );
    const settled = Promise.all(clients);
    assert.ok(pending.length >= 2, 'CIMD lookups actually reached DNS');
    t.mock.timers.tick(5000);
    assert.deepEqual(await settled, Array(8).fill(undefined));
    const beforeWebhook = pending.length;
    const webhook = resolveCallbackTarget('https://webhook.example.com/');
    const webhookResult = webhook.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert.equal(pending.length, beforeWebhook + 1, 'webhook lookup is admitted');
    pending.at(-1)?.([{ address: PUBLIC_ADDRESS, family: 4 }]);
    assert.deepEqual(
      ((await webhookResult) as { value: { address: string } }).value.address,
      PUBLIC_ADDRESS,
    );
  } finally {
    for (const resolve of pending) resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    dns.lookup = original;
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
});

test('CIMD DNS remains bounded after timeout and reopens on settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = dns.lookup;
  const pending: Array<{
    resolve: (value: { address: string; family: number }[]) => void;
    reject: (error: Error) => void;
  }> = [];
  let calls = 0;
  dns.lookup = (() => {
    calls++;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  }) as typeof dns.lookup;
  syncBuiltinESMExports();
  const cimd = new CimdResolver({ redirects: { exact: [], loopback: false }, log: () => {} });
  const batch = (n: number) =>
    Array.from({ length: 10 }, (_, i) => {
      const url = `https://client${n}-${i}.example.com/metadata`;
      return i < 2
        ? cimd.resolve(url)
        : postCallback({ url, headers: {}, body: '', timeoutMs: 1000 });
    });
  try {
    const first = batch(1);
    const firstSettled = Promise.allSettled(first);
    assert.equal(calls, 10);
    t.mock.timers.tick(5000);
    const results = await firstSettled;
    assert.ok(
      results.some(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof CallbackError &&
          result.reason.reason === 'timeout',
      ),
    );
    for (let i = 0; i < 3; i++) {
      const settled = Promise.allSettled(
        Array.from({ length: 2 }, (_, j) =>
          cimd.resolve(`https://client${i + 2}-${j}.example.com/metadata`),
        ),
      );
      t.mock.timers.tick(5000);
      await settled;
      assert.equal(calls, 10, 'timed-out lookups must still occupy admission slots');
    }
    pending[0].reject(new Error('late DNS failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reopenedCimd = cimd.resolve('https://reopened-cimd.example.com/metadata');
    assert.equal(calls, 11);
    pending[10].reject(new Error('DNS failure'));
    assert.equal(await reopenedCimd, undefined);
    pending[2].resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reopened = resolveCallbackTarget('https://reopened.example.com/');
    assert.equal(calls, 12);
    pending[11].resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    assert.equal((await reopened).address, PUBLIC_ADDRESS);
    dns.lookup = (async () => {
      throw new Error('DNS failure');
    }) as typeof dns.lookup;
    syncBuiltinESMExports();
    await assert.rejects(
      resolveCallbackTarget('https://error.example.com/'),
      (error: unknown) => error instanceof CallbackError && error.reason === 'connection_refused',
    );
  } finally {
    for (const lookup of pending) lookup.resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    dns.lookup = original;
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
});

test('CIMD synchronous DNS throws release admission slots', async () => {
  const original = dns.lookup;
  let calls = 0;
  dns.lookup = (() => {
    calls++;
    throw new Error('synchronous DNS failure');
  }) as typeof dns.lookup;
  syncBuiltinESMExports();
  const cimd = new CimdResolver({ redirects: { exact: [], loopback: false }, log: () => {} });
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal(await cimd.resolve(`https://sync${i}.example.com/metadata`), undefined);
    }
    assert.equal(calls, 4, 'every lookup reaches DNS despite prior synchronous failures');
  } finally {
    dns.lookup = original;
    syncBuiltinESMExports();
  }
});

test('late CIMD DNS rejection after timeout releases its slot without an unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = dns.lookup;
  const pending: Array<(error: Error) => void> = [];
  dns.lookup = (() => new Promise((_resolve, reject) => pending.push(reject))) as typeof dns.lookup;
  syncBuiltinESMExports();
  const cimd = new CimdResolver({ redirects: { exact: [], loopback: false }, log: () => {} });
  try {
    const first = cimd.resolve('https://late.example.com/metadata');
    const second = cimd.resolve('https://late2.example.com/metadata');
    assert.equal(pending.length, 2);
    t.mock.timers.tick(5000);
    assert.equal(await first, undefined);
    assert.equal(await second, undefined);
    pending[0](new Error('late DNS failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = cimd.resolve('https://next.example.com/metadata');
    assert.equal(pending.length, 3);
    pending[2](new Error('immediate DNS failure'));
    assert.equal(await next, undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    for (const reject of pending) reject(new Error('cleanup'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    dns.lookup = original;
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
});

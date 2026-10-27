import test from 'node:test';
import assert from 'node:assert/strict';
/* The address table is the subject of these tests. */
/* eslint-disable sonarjs/no-hardcoded-ip */
import {
  CallbackError,
  isPublicAddress,
  parseWebhookSecret,
  pinnedLookup,
  resolveCallbackTarget,
  safeEqual,
  signWebhook,
  statusFailure,
  validateCallbackUrl,
  type CallbackTarget,
} from '../src/webhook.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const PUBLIC_V4 = '93.184.216.34';
const HOOKS_HOST = 'hooks.example.com';

test('public IPv4 ranges are allowed and private, local and reserved ranges are blocked', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', PUBLIC_V4]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('public IPv6 ranges are allowed and local, documentation and IPv4-embedded private ranges blocked', () => {
  for (const address of [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '2002:0808:0808::',
    '64:ff9b::808:808',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '100::1',
    '2001:db8::1',
    '2001::1',
    '2001:2::1',
    '2002:7f00:1::',
    '::ffff:127.0.0.1',
    '::ffff:0:127.0.0.1',
    '64:ff9b::7f00:1',
    '3fff::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('::ffff:0:8.8.8.8'), true);
});

test('callback URLs require HTTPS and a public, fully qualified host without credentials', () => {
  assert.equal(validateCallbackUrl('https://hooks.example.com/mcp').hostname, HOOKS_HOST);
  for (const url of [
    'http://hooks.example.com/mcp',
    'https://user:pass@hooks.example.com/mcp',
    'https://localhost/mcp',
    'https://receiver.local/mcp',
    'https://internal/mcp',
  ]) {
    assert.throws(() => validateCallbackUrl(url), CallbackError, url);
  }
});

test('DNS validation rejects a hostname with any non-public answer', async () => {
  await assert.rejects(resolveCallbackTarget('https://127.0.0.1/mcp'), (error: unknown) => {
    assert.ok(error instanceof CallbackError);
    assert.equal(error.reason, 'challenge_failed');
    return true;
  });
  await assert.rejects(resolveCallbackTarget('https://[::1]/mcp'), CallbackError);
});

test('pinned lookup answers scalar and autoSelectFamily array modes', async () => {
  const target: CallbackTarget = {
    url: new URL('https://hooks.example.com/mcp'),
    host: HOOKS_HOST,
    address: PUBLIC_V4,
    family: 4,
  };
  const lookup = pinnedLookup(target);
  const scalar = await new Promise<unknown[]>((resolve) =>
    lookup(HOOKS_HOST, {}, (...args) => resolve(args)),
  );
  assert.deepEqual(scalar, [null, PUBLIC_V4, 4]);
  const all = await new Promise<unknown[]>((resolve) =>
    lookup(HOOKS_HOST, { all: true }, (...args) => resolve(args)),
  );
  assert.deepEqual(all, [null, [{ address: PUBLIC_V4, family: 4 }]]);
});

test('signing secrets require whsec_ and a 24 to 64 byte base64 key', () => {
  assert.equal(parseWebhookSecret(SECRET)?.length, 24);
  assert.equal(parseWebhookSecret(`whsec_${Buffer.alloc(64, 7).toString('base64')}`)?.length, 64);
  for (const secret of [
    'plain-secret',
    'whsec_',
    `whsec_${Buffer.alloc(23, 7).toString('base64')}`,
    `whsec_${Buffer.alloc(65, 7).toString('base64')}`,
    'whsec_not base64!!',
  ]) {
    assert.equal(parseWebhookSecret(secret), undefined, secret);
  }
});

test('Standard Webhooks HMAC matches the published test vector', () => {
  const key = parseWebhookSecret(SECRET);
  assert.ok(key);
  const signature = signWebhook(
    key,
    'msg_p5jXN8AQM9LWM0D4loKWxJek',
    1614265330,
    '{"test": 2432232314}',
  );
  assert.equal(signature, 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
});

test('constant-time compare requires equal length and bytes', () => {
  assert.equal(safeEqual('challenge', 'challenge'), true);
  assert.equal(safeEqual('challenge', 'challengf'), false);
  assert.equal(safeEqual('challenge', 'short'), false);
});

test('callback HTTP statuses map to protocol verification reasons', () => {
  assert.equal(statusFailure(204), undefined);
  assert.equal(statusFailure(404)?.reason, 'http_4xx');
  assert.equal(statusFailure(503)?.reason, 'http_5xx');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  MAX_CLIENTS,
  MAX_PENDING,
  OAuthStore,
  PENDING_TTL_MS,
  REFRESH_TTL_MS,
  StoreFullError,
  UNUSED_CLIENT_TTL_MS,
} from '../src/oauth-store.ts';
import { removeDir, tempDir } from './helpers.ts';

const RESOURCE = 'https://mcp.example.com/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function harness() {
  const dir = tempDir('tf-oauth-store-');
  const file = path.join(dir, 'nested', 'oauth.json');
  const clock = { t: 1_700_000_000_000 };
  const open = () => new OAuthStore(file, () => clock.t);
  return { dir, file, clock, open, store: open(), done: () => removeDir(dir) };
}

function signIn(store: OAuthStore, clientId: string) {
  const code = store.issueCode({
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: 'c'.repeat(43),
    scope: ['taskferry'],
    resource: RESOURCE,
  });
  const spent = store.consumeCode(code);
  assert.equal(spent.kind, 'ok');
  if (spent.kind !== 'ok') throw new Error('unreachable');
  const issued = store.issueTokens({
    clientId,
    scope: spent.grant.scope,
    resource: spent.grant.resource,
    codeHash: spent.codeHash,
  });
  return { code, issued };
}

const register = (store: OAuthStore) =>
  store.registerClient({ clientName: 'Test client', redirectUris: [REDIRECT] });

test('an authorization code works once, and replaying it revokes what it produced', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const { code, issued } = signIn(h.store, client.clientId);
    assert.ok(h.store.verifyAccess(issued.accessToken, RESOURCE));

    assert.equal(h.store.consumeCode(code).kind, 'invalid');

    assert.equal(h.store.verifyAccess(issued.accessToken, RESOURCE), undefined);
    const refreshed = h.store.rotateRefresh(issued.refreshToken, client.clientId, undefined);
    assert.equal(refreshed.kind, 'invalid');
  } finally {
    h.done();
  }
});

test('a code expires after its lifetime and an unknown code is simply invalid', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const code = h.store.issueCode({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: 'c'.repeat(43),
      scope: ['taskferry'],
      resource: RESOURCE,
    });
    h.clock.t += CODE_TTL_MS;
    assert.equal(h.store.consumeCode(code).kind, 'invalid');
    assert.equal(h.store.consumeCode('never-issued').kind, 'invalid');
  } finally {
    h.done();
  }
});

test('access tokens are bound to the resource and expire', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const { issued } = signIn(h.store, client.clientId);
    assert.equal(h.store.verifyAccess(issued.accessToken, RESOURCE)?.clientId, client.clientId);
    assert.equal(
      h.store.verifyAccess(issued.accessToken, 'https://other.example.com/mcp'),
      undefined,
    );
    assert.equal(h.store.verifyAccess('not-a-token', RESOURCE), undefined);
    h.clock.t += ACCESS_TTL_MS;
    assert.equal(h.store.verifyAccess(issued.accessToken, RESOURCE), undefined);
  } finally {
    h.done();
  }
});

test('refresh rotation issues a new pair, and presenting the old token revokes the family', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const first = signIn(h.store, client.clientId).issued;

    const second = h.store.rotateRefresh(first.refreshToken, client.clientId, undefined);
    assert.equal(second.kind, 'ok');
    if (second.kind !== 'ok') throw new Error('unreachable');
    assert.notEqual(second.issued.refreshToken, first.refreshToken);
    assert.ok(h.store.verifyAccess(second.issued.accessToken, RESOURCE));

    // The first refresh token was already used: someone else holds it.
    assert.equal(
      h.store.rotateRefresh(first.refreshToken, client.clientId, undefined).kind,
      'reuse',
    );
    assert.equal(h.store.verifyAccess(second.issued.accessToken, RESOURCE), undefined);
    assert.equal(
      h.store.rotateRefresh(second.issued.refreshToken, client.clientId, undefined).kind,
      'invalid',
    );
  } finally {
    h.done();
  }
});

test('a refresh token is refused for another client and past its lifetime', () => {
  const h = harness();
  try {
    const owner = register(h.store);
    const other = register(h.store);
    const { issued } = signIn(h.store, owner.clientId);
    assert.equal(
      h.store.rotateRefresh(issued.refreshToken, other.clientId, undefined).kind,
      'invalid',
    );
    // A refusal for the wrong client must not burn the real client's token.
    assert.equal(h.store.rotateRefresh(issued.refreshToken, owner.clientId, undefined).kind, 'ok');

    const again = signIn(h.store, owner.clientId).issued;
    h.clock.t += REFRESH_TTL_MS;
    assert.equal(
      h.store.rotateRefresh(again.refreshToken, owner.clientId, undefined).kind,
      'invalid',
    );
  } finally {
    h.done();
  }
});

test('a refresh cannot widen the original scope', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const { issued } = signIn(h.store, client.clientId);
    const wider = h.store.rotateRefresh(issued.refreshToken, client.clientId, [
      'taskferry',
      'admin',
    ]);
    assert.equal(wider.kind, 'invalid_scope');
    // The refusal did not spend the token.
    assert.equal(
      h.store.rotateRefresh(issued.refreshToken, client.clientId, ['taskferry']).kind,
      'ok',
    );
  } finally {
    h.done();
  }
});

test('revoking a token takes down its whole family, but only for the client that owns it', () => {
  const h = harness();
  try {
    const owner = register(h.store);
    const other = register(h.store);
    const { issued } = signIn(h.store, owner.clientId);

    h.store.revokeToken(issued.refreshToken, other.clientId);
    assert.ok(h.store.verifyAccess(issued.accessToken, RESOURCE));

    h.store.revokeToken(issued.refreshToken, owner.clientId);
    assert.equal(h.store.verifyAccess(issued.accessToken, RESOURCE), undefined);
    assert.equal(
      h.store.rotateRefresh(issued.refreshToken, owner.clientId, undefined).kind,
      'invalid',
    );
    // Unknown tokens are not an error (RFC 7009).
    h.store.revokeToken('unknown', owner.clientId);
  } finally {
    h.done();
  }
});

test('pending authorizations expire and are taken exactly once', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const input = {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: 'c'.repeat(43),
      state: 'abc',
      scope: ['taskferry'],
      resource: RESOURCE,
    };
    const id = h.store.createPending(input);
    assert.equal(h.store.peekPending(id)?.state, 'abc');
    assert.equal(h.store.takePending(id)?.id, id);
    assert.equal(h.store.peekPending(id), undefined);

    const late = h.store.createPending(input);
    h.clock.t += PENDING_TTL_MS;
    assert.equal(h.store.peekPending(late), undefined);
  } finally {
    h.done();
  }
});

test('capacity caps refuse with StoreFullError instead of growing without bound', () => {
  const h = harness();
  try {
    for (let i = 0; i < MAX_CLIENTS; i += 1) register(h.store);
    assert.throws(() => register(h.store), StoreFullError);
    // Unused registrations age out, which frees the slots again.
    h.clock.t += UNUSED_CLIENT_TTL_MS;
    assert.doesNotThrow(() => register(h.store));

    const client = register(h.store);
    const input = {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: 'c'.repeat(43),
      state: 'capacity',
      scope: ['taskferry'],
      resource: RESOURCE,
    };
    for (let i = 0; i < MAX_PENDING; i += 1) h.store.createPending(input);
    assert.throws(() => h.store.createPending(input), StoreFullError);
  } finally {
    h.done();
  }
});

test('only refresh state survives a restart, and the file holds hashes, never tokens', () => {
  const h = harness();
  try {
    const approved = register(h.store);
    const abandoned = register(h.store);
    const { issued } = signIn(h.store, approved.clientId);

    const mode = statSync(h.file).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(statSync(path.dirname(h.file)).mode & 0o777, 0o700);
    const text = readFileSync(h.file, 'utf8');
    assert.ok(!text.includes(issued.refreshToken));
    assert.ok(!text.includes(issued.accessToken));
    assert.ok(!text.includes(abandoned.clientId), 'unapproved registrations are not persisted');

    const reopened = h.open();
    assert.equal(reopened.getClient(approved.clientId)?.clientName, 'Test client');
    assert.equal(reopened.getClient(abandoned.clientId), undefined);
    // Access tokens are memory-only: a restart makes the client refresh.
    assert.equal(reopened.verifyAccess(issued.accessToken, RESOURCE), undefined);
    const next = reopened.rotateRefresh(issued.refreshToken, approved.clientId, undefined);
    assert.equal(next.kind, 'ok');
    if (next.kind !== 'ok') throw new Error('unreachable');
    assert.ok(reopened.verifyAccess(next.issued.accessToken, RESOURCE));
  } finally {
    h.done();
  }
});

test('a rotation is persisted, so reuse is still detected after a restart', () => {
  const h = harness();
  try {
    const client = register(h.store);
    const { issued } = signIn(h.store, client.clientId);
    assert.equal(h.store.rotateRefresh(issued.refreshToken, client.clientId, undefined).kind, 'ok');
    assert.equal(
      h.open().rotateRefresh(issued.refreshToken, client.clientId, undefined).kind,
      'reuse',
    );
  } finally {
    h.done();
  }
});

test('a corrupt or foreign state file stops startup instead of being replaced', () => {
  const h = harness();
  try {
    const client = register(h.store);
    signIn(h.store, client.clientId);
    writeFileSync(h.file, '{not json');
    assert.throws(() => h.open(), /not valid JSON/);
    writeFileSync(h.file, JSON.stringify({ version: 99, clients: [], refresh: [] }));
    assert.throws(() => h.open(), /unsupported shape/);
    writeFileSync(h.file, JSON.stringify({ version: 1, clients: [], refresh: [{ hash: 1 }] }));
    assert.throws(() => h.open(), /bad refresh record/);
  } finally {
    h.done();
  }
});

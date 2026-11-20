import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isRecord, isStrings } from './json.ts';
import { writePrivate } from './private-file.ts';

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const UNUSED_CLIENT_TTL_MS = 60 * 60 * 1000;
export const MAX_CLIENTS = 100;
export const MAX_PENDING = 50;
export const MAX_CODES = 100;
export const MAX_REFRESH = 500;
// Access tokens are memory only, so this cap is a safety valve rather than a persistence bound.
export const MAX_ACCESS = 1000;
// Spent authorization codes are kept to detect replay; the cap keeps that table from growing
// forever on a busy server.
export const MAX_USED_CODES = 1000;
const REFRESH_CAPACITY = 'refresh tokens';
const STORE_VERSION = 1;

export type Client = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};
// What the protocol handlers need. Client ID Metadata Documents resolve to this shape without a
// stored registration, so nothing downstream may depend on createdAt.
export type ClientView = Pick<Client, 'clientId' | 'clientName' | 'redirectUris'>;
// An authorization request that passed validation and waits for the owner's decision. The
// approval POST names it by id only, so the request cannot be altered between page and decision.
export type Pending = {
  id: string;
  clientId: string;
  // Captured at authorization time so the consent/error pages never depend on a client lookup,
  // which for a Client ID Metadata Document means a network fetch.
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  scope: string[];
  resource: string;
  expiresAt: number;
};
export type CodeGrant = Omit<Pending, 'id' | 'state' | 'clientName'>;
type Refresh = {
  hash: string;
  familyId: string;
  clientId: string;
  scope: string[];
  resource: string;
  expiresAt: number;
  rotated: boolean;
};
type Access = Omit<Refresh, 'hash' | 'rotated'>;
export type Issued = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string[];
};
export type CodeResult = { kind: 'ok'; grant: CodeGrant; codeHash: string } | { kind: 'invalid' };
export type RotateResult =
  { kind: 'ok'; issued: Issued } | { kind: 'invalid' | 'reuse' | 'invalid_scope' };

// Thrown when a capacity cap is reached. Callers turn it into a retryable server error.
export class StoreFullError extends Error {
  constructor(what: string) {
    super(`too many ${what}`);
    this.name = 'StoreFullError';
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

function parseClient(v: unknown): Client {
  if (!isRecord(v)) throw new Error('client is not an object');
  const { clientId, clientName, redirectUris, createdAt } = v;
  if (typeof clientId !== 'string' || typeof clientName !== 'string') throw new Error('bad client');
  if (!isStrings(redirectUris) || typeof createdAt !== 'number') throw new Error('bad client');
  return { clientId, clientName, redirectUris, createdAt };
}

function parseState(parsed: unknown, file: string) {
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION) {
    throw new Error(`OAuth state file ${file} has an unsupported shape`);
  }
  const { clients, refresh, usedCodes } = parsed;
  if (
    !Array.isArray(clients) ||
    !Array.isArray(refresh) ||
    (usedCodes !== undefined && !Array.isArray(usedCodes))
  ) {
    throw new Error(`OAuth state file ${file} has an unsupported shape`);
  }
  return { clients, refresh, usedCodes: usedCodes ?? [] };
}

function parseUsedCode(v: unknown): { familyId: string; expiresAt: number } {
  if (!isRecord(v)) throw new Error('bad spent code record');
  const { familyId, expiresAt } = v;
  if (typeof familyId !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('bad spent code record');
  }
  return { familyId, expiresAt };
}

function parseRefresh(v: unknown): Refresh {
  if (!isRecord(v)) throw new Error('refresh record is not an object');
  const { hash, familyId, clientId, scope, resource, expiresAt, rotated } = v;
  const strings = [hash, familyId, clientId, resource].every((s) => typeof s === 'string');
  if (!strings || !isStrings(scope) || typeof expiresAt !== 'number') {
    throw new Error('bad refresh record');
  }
  if (typeof rotated !== 'boolean') throw new Error('bad refresh record');
  return { hash, familyId, clientId, scope, resource, expiresAt, rotated } as Refresh;
}

export class OAuthStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly clients = new Map<string, Client>();
  private readonly refresh = new Map<string, Refresh>();
  // Memory only. A restart drops them: clients refresh, and an in-flight sign-in starts over.
  private readonly access = new Map<string, Access>();
  private readonly codes = new Map<string, CodeGrant>();
  private readonly usedCodes = new Map<string, { familyId: string; expiresAt: number }>();
  private readonly pending = new Map<string, Pending>();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`OAuth state file ${this.file} is not valid JSON`, { cause: error });
    }
    const state = parseState(parsed, this.file);
    for (const entry of state.clients) {
      const client = parseClient(entry);
      this.clients.set(client.clientId, client);
    }
    for (const entry of state.refresh) {
      const record = parseRefresh(entry);
      this.refresh.set(record.hash, record);
    }
    this.loadUsedCodes(state.usedCodes);
  }

  private loadUsedCodes(entries: unknown[]) {
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.hash !== 'string') {
        throw new Error(`OAuth state file ${this.file} has an unsupported shape`);
      }
      const record = parseUsedCode(entry);
      if (record.expiresAt > this.now()) this.usedCodes.set(entry.hash, record);
    }
  }

  // Only what must outlive a restart is written: refresh records, spent codes, and the clients
  // they name. Unapproved registrations stay in memory, so an anonymous caller cannot grow this
  // file. A caller that narrows the state (revocation) passes the narrowed tables so the write
  // happens before memory changes: a failed write leaves the grant alive and the call retryable.
  private persist(
    refresh: Iterable<Refresh> = this.refresh.values(),
    usedCodes: Iterable<[string, { familyId: string; expiresAt: number }]> = this.usedCodes,
  ) {
    const refreshList = [...refresh];
    const named = new Set(refreshList.map((r) => r.clientId));
    const clients = [...this.clients.values()].filter((c) => named.has(c.clientId));
    const spent = [...usedCodes].map(([hash, record]) => ({ ...record, hash }));
    writePrivate(
      this.file,
      JSON.stringify({ clients, version: STORE_VERSION, refresh: refreshList, usedCodes: spent }),
    );
  }

  private prune() {
    const t = this.now();
    const live = <V extends { expiresAt: number }>(map: Map<string, V>) => {
      for (const [key, value] of map) if (value.expiresAt <= t) map.delete(key);
    };
    live(this.access);
    live(this.codes);
    live(this.usedCodes);
    live(this.pending);
    live(this.refresh);
    // A sign-in that has not finished yet (pending request or unspent code) still names its
    // registration, so the unused-registration timer must not drop it mid-flow.
    const named = new Set([
      ...[...this.refresh.values()].map((r) => r.clientId),
      ...[...this.pending.values()].map((p) => p.clientId),
      ...[...this.codes.values()].map((c) => c.clientId),
    ]);
    for (const client of this.clients.values()) {
      if (!named.has(client.clientId) && client.createdAt + UNUSED_CLIENT_TTL_MS <= t) {
        this.clients.delete(client.clientId);
      }
    }
  }

  registerClient(input: { clientName: string; redirectUris: string[] }): Client {
    this.prune();
    if (this.clients.size >= MAX_CLIENTS) throw new StoreFullError('registered clients');
    const client: Client = {
      clientId: newToken().slice(0, 32),
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: this.now(),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): Client | undefined {
    return this.clients.get(clientId);
  }

  createPending(input: Omit<Pending, 'id' | 'expiresAt'>): string {
    this.prune();
    if (this.pending.size >= MAX_PENDING) throw new StoreFullError('pending authorizations');
    const id = newToken();
    this.pending.set(id, { ...input, expiresAt: this.now() + PENDING_TTL_MS, id });
    return id;
  }

  peekPending(id: string): Pending | undefined {
    const found = this.pending.get(id);
    if (found && found.expiresAt <= this.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return found;
  }

  takePending(id: string): Pending | undefined {
    const found = this.peekPending(id);
    this.pending.delete(id);
    return found;
  }

  issueCode(grant: Omit<CodeGrant, 'expiresAt'>): string {
    this.prune();
    if (this.codes.size >= MAX_CODES) throw new StoreFullError('authorization codes');
    const code = newToken();
    this.codes.set(hashToken(code), { ...grant, expiresAt: this.now() + CODE_TTL_MS });
    return code;
  }

  // A code is spent the moment it is presented, whether or not the rest of the request checks
  // out. Presenting a spent code again means it leaked: the grant it produced is revoked.
  consumeCode(code: string): CodeResult {
    const key = hashToken(code);
    const grant = this.codes.get(key);
    this.codes.delete(key);
    if (!grant) {
      const used = this.usedCodes.get(key);
      if (used) this.revokeFamily(used.familyId);
      return { kind: 'invalid' };
    }
    if (grant.expiresAt <= this.now()) return { kind: 'invalid' };
    return { grant, kind: 'ok', codeHash: key };
  }

  issueTokens(input: {
    clientId: string;
    scope: string[];
    resource: string;
    familyId?: string;
    codeHash?: string;
  }): Issued {
    const t = this.now();
    const familyId = input.familyId ?? newToken().slice(0, 24);
    const accessToken = newToken();
    const refreshToken = newToken();
    const base = {
      familyId,
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource,
    };
    // Both caps are applied before anything is written, so a refusal leaves the store unchanged.
    this.prune();
    this.evictRefresh();
    this.evictAccess();
    const refresh = new Map(this.refresh);
    const hash = hashToken(refreshToken);
    refresh.set(hash, { ...base, hash, expiresAt: t + REFRESH_TTL_MS, rotated: false });
    const usedCodes = new Map(this.usedCodes);
    if (input.codeHash) {
      this.evictUsedCodes(usedCodes);
      usedCodes.set(input.codeHash, { familyId, expiresAt: t + REFRESH_TTL_MS });
    }
    // Durable first, like revokeFamily: a failed write leaves the presented grant unspent and
    // every token from the previous state still valid.
    this.persist(refresh.values(), usedCodes);
    this.replace(this.refresh, refresh);
    this.replace(this.usedCodes, usedCodes);
    this.access.set(hashToken(accessToken), { ...base, expiresAt: t + ACCESS_TTL_MS });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope: input.scope };
  }

  // A new sign-in is refused before its authorization code is spent, so a full store does not
  // burn a code the owner would have to obtain again.
  assertNewGrantCapacity(): void {
    this.prune();
    if (this.refresh.size < MAX_REFRESH || this.rotatedRecord()) return;
    throw new StoreFullError(REFRESH_CAPACITY);
  }

  // Keeps the refresh table under its cap by dropping already-rotated records, which only serve
  // reuse detection. A live grant is never evicted: when every slot holds one, the caller gets a
  // retryable error rather than a token that silently stops working.
  private evictRefresh() {
    while (this.refresh.size >= MAX_REFRESH) {
      const rotated = this.rotatedRecord();
      if (!rotated) throw new StoreFullError(REFRESH_CAPACITY);
      this.refresh.delete(rotated.hash);
    }
  }

  private rotatedRecord(): Refresh | undefined {
    return [...this.refresh.values()].find((record) => record.rotated);
  }

  // A rotation needs one free slot before it can retire the old record. Dropping an older
  // rotated record keeps reuse detection intact; when every slot is live the call is refused and
  // the presented token stays valid, so the client can retry once capacity frees up.
  private ensureRotationRoom() {
    this.prune();
    if (this.refresh.size < MAX_REFRESH) return;
    const rotated = this.rotatedRecord();
    if (!rotated) throw new StoreFullError(REFRESH_CAPACITY);
    this.refresh.delete(rotated.hash);
  }

  // Oldest first. A capped server invalidates the oldest access tokens instead of growing.
  private evictAccess() {
    while (this.access.size >= MAX_ACCESS) {
      const oldest = this.access.keys().next().value;
      if (oldest === undefined) return;
      this.access.delete(oldest);
    }
  }

  private evictUsedCodes(usedCodes: Map<string, { familyId: string; expiresAt: number }>) {
    while (usedCodes.size >= MAX_USED_CODES) {
      const oldest = usedCodes.keys().next().value;
      if (oldest === undefined) return;
      usedCodes.delete(oldest);
    }
  }

  // Presenting an already-rotated refresh token means two parties hold it: the whole family,
  // every refresh and access token descended from that sign-in, is revoked.
  rotateRefresh(
    token: string,
    clientId: string,
    requested: string[] | undefined,
    expectedResource?: string,
  ): RotateResult {
    const record = this.refresh.get(hashToken(token));
    if (!record || record.expiresAt <= this.now() || record.clientId !== clientId) {
      return { kind: 'invalid' };
    }
    // The resource is fixed when the code is issued. If the configured resource changed since,
    // the grant no longer belongs to this server: revoke it and make the client sign in again.
    if (expectedResource !== undefined && record.resource !== expectedResource) {
      this.revokeFamily(record.familyId);
      return { kind: 'invalid' };
    }
    if (record.rotated) {
      this.revokeFamily(record.familyId);
      return { kind: 'reuse' };
    }
    if (requested && !requested.every((s) => record.scope.includes(s))) {
      return { kind: 'invalid_scope' };
    }
    // Make room before touching the record: a capacity refusal must leave the presented token
    // usable. The old record is retired before the write so the file records the rotation;
    // issueTokens is durable-first, so a failed write leaves memory otherwise unchanged and the
    // flag is rolled back for a clean retry.
    this.ensureRotationRoom();
    record.rotated = true;
    try {
      const issued = this.issueTokens({
        clientId,
        scope: requested ?? record.scope,
        resource: record.resource,
        familyId: record.familyId,
      });
      return { kind: 'ok', issued };
    } catch (error) {
      record.rotated = false;
      throw error;
    }
  }

  // Durable first: narrow the tables, write them, and only then drop the in-memory grants. A
  // failed write leaves memory unchanged, so the caller can retry and the family stays consistent
  // with the file.
  revokeFamily(familyId: string) {
    this.prune();
    const refresh = new Map([...this.refresh].filter(([, r]) => r.familyId !== familyId));
    const usedCodes = new Map([...this.usedCodes].filter(([, u]) => u.familyId !== familyId));
    this.persist(refresh.values(), usedCodes);
    this.replace(this.refresh, refresh);
    this.replace(this.usedCodes, usedCodes);
    this.replace(this.access, new Map([...this.access].filter(([, a]) => a.familyId !== familyId)));
  }

  private replace<V>(target: Map<string, V>, source: Map<string, V>) {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  }

  // RFC 7009: revoking a token that is unknown, expired or someone else's is not an error. The
  // client id is a hint, not authentication, so revocation never re-fetches client metadata.
  revokeToken(token: string, clientId?: string) {
    const key = hashToken(token);
    // An access token identifies the same family as its refresh token, so revoking either ends
    // the grant; with short-lived access tokens that is the only way to retire what is held.
    const found = this.refresh.get(key) ?? this.access.get(key);
    if (!found) return;
    if (clientId !== undefined && found.clientId !== clientId) return;
    this.revokeFamily(found.familyId);
  }

  verifyAccess(token: string, resource: string): { clientId: string } | undefined {
    const key = hashToken(token);
    const found = this.access.get(key);
    if (!found) return undefined;
    if (found.expiresAt <= this.now()) {
      this.access.delete(key);
      return undefined;
    }
    return found.resource === resource ? { clientId: found.clientId } : undefined;
  }
}

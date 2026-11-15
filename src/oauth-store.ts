import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
const STORE_VERSION = 1;

export type Client = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};
// An authorization request that passed validation and waits for the owner's decision. The
// approval POST names it by id only, so the request cannot be altered between page and decision.
export type Pending = {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  scope: string[];
  resource: string;
  expiresAt: number;
};
export type CodeGrant = Omit<Pending, 'id' | 'state'>;
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
  | { kind: 'ok'; issued: Issued; clientId: string }
  | { kind: 'invalid' | 'reuse' | 'invalid_scope' };

// Thrown when a capacity cap is reached. Callers turn it into a retryable server error.
export class StoreFullError extends Error {
  constructor(what: string) {
    super(`too many ${what}`);
    this.name = 'StoreFullError';
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

function parseClient(v: unknown): Client {
  if (!isRecord(v)) throw new Error('client is not an object');
  const { clientId, clientName, redirectUris, createdAt } = v;
  if (typeof clientId !== 'string' || typeof clientName !== 'string') throw new Error('bad client');
  if (!isStrings(redirectUris) || typeof createdAt !== 'number') throw new Error('bad client');
  return { clientId, clientName, redirectUris, createdAt };
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
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION) {
      throw new Error(`OAuth state file ${this.file} has an unsupported shape`);
    }
    if (!Array.isArray(parsed.clients) || !Array.isArray(parsed.refresh)) {
      throw new Error(`OAuth state file ${this.file} has an unsupported shape`);
    }
    for (const entry of parsed.clients) {
      const client = parseClient(entry);
      this.clients.set(client.clientId, client);
    }
    for (const entry of parsed.refresh) {
      const record = parseRefresh(entry);
      this.refresh.set(record.hash, record);
    }
  }

  // Only what must outlive a restart is written: refresh records and the clients they name.
  // Unapproved registrations stay in memory, so an anonymous caller cannot grow this file.
  private save() {
    this.prune();
    const refresh = [...this.refresh.values()];
    const named = new Set(refresh.map((r) => r.clientId));
    const clients = [...this.clients.values()].filter((c) => named.has(c.clientId));
    writePrivate(this.file, JSON.stringify({ version: STORE_VERSION, clients, refresh }));
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
    const named = new Set([...this.refresh.values()].map((r) => r.clientId));
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
    this.pending.set(id, { ...input, id, expiresAt: this.now() + PENDING_TTL_MS });
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
    this.access.set(hashToken(accessToken), { ...base, expiresAt: t + ACCESS_TTL_MS });
    this.evictRefresh();
    const hash = hashToken(refreshToken);
    this.refresh.set(hash, { ...base, hash, expiresAt: t + REFRESH_TTL_MS, rotated: false });
    if (input.codeHash) {
      this.usedCodes.set(input.codeHash, { familyId, expiresAt: t + REFRESH_TTL_MS });
    }
    this.save();
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope: input.scope };
  }

  // Keeps the refresh table under its cap by dropping already-rotated records first (they only
  // serve reuse detection), then the oldest.
  private evictRefresh() {
    while (this.refresh.size >= MAX_REFRESH) {
      const rotated = [...this.refresh.values()].find((r) => r.rotated);
      const victim = rotated ?? this.refresh.values().next().value;
      if (!victim) return;
      this.refresh.delete(victim.hash);
    }
  }

  // Presenting an already-rotated refresh token means two parties hold it: the whole family,
  // every refresh and access token descended from that sign-in, is revoked.
  rotateRefresh(token: string, clientId: string, requested: string[] | undefined): RotateResult {
    const record = this.refresh.get(hashToken(token));
    if (!record || record.expiresAt <= this.now() || record.clientId !== clientId) {
      return { kind: 'invalid' };
    }
    if (record.rotated) {
      this.revokeFamily(record.familyId);
      return { kind: 'reuse' };
    }
    if (requested && !requested.every((s) => record.scope.includes(s))) {
      return { kind: 'invalid_scope' };
    }
    record.rotated = true;
    const issued = this.issueTokens({
      clientId,
      scope: requested ?? record.scope,
      resource: record.resource,
      familyId: record.familyId,
    });
    return { kind: 'ok', issued, clientId };
  }

  revokeFamily(familyId: string) {
    for (const [key, r] of this.refresh) if (r.familyId === familyId) this.refresh.delete(key);
    for (const [key, a] of this.access) if (a.familyId === familyId) this.access.delete(key);
    this.save();
  }

  // RFC 7009: revoking a token that is unknown, expired or someone else's is not an error.
  revokeToken(token: string, clientId: string) {
    const key = hashToken(token);
    const refresh = this.refresh.get(key);
    if (refresh?.clientId === clientId) this.revokeFamily(refresh.familyId);
    const access = this.access.get(key);
    if (access?.clientId === clientId) this.access.delete(key);
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

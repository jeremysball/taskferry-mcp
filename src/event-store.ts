import { existsSync, readFileSync } from 'node:fs';
import { EVENT_NAMES, type EventName } from './event-catalog.ts';
import type { Json } from './daemon.ts';
import { writePrivate } from './private-file.ts';

export const MAX_SUBSCRIPTIONS = 1000;
const STORE_VERSION = 1;

export type StoredSubscription = {
  id: string;
  principal: string;
  name: EventName;
  arguments: Json;
  url: string;
  secret: string;
  createdAt: string;
  refreshBefore: string | null;
};

type StoreFile = { version: number; subscriptions: StoredSubscription[] };

function compareKeys(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// JSON with recursively sorted object keys. ChatGPT sends the same logical arguments with
// arbitrary key order, and those must collapse to one subscription identity.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Json)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || value === '') throw new Error(`subscription has no ${key}`);
  return value;
}

function parseSubscription(value: unknown): StoredSubscription {
  if (typeof value !== 'object' || value === null) throw new Error('subscription is not an object');
  const entry = value as Record<string, unknown>;
  const id = requiredString(entry, 'id');
  const principal = requiredString(entry, 'principal');
  const url = requiredString(entry, 'url');
  const secret = requiredString(entry, 'secret');
  const createdAt = requiredString(entry, 'createdAt');
  if (!isEventName(entry.name)) throw new Error('subscription has an unknown event name');
  if (!isRecord(entry.arguments)) throw new Error('subscription arguments are not an object');
  if (entry.refreshBefore !== null && typeof entry.refreshBefore !== 'string') {
    throw new Error('subscription refreshBefore is invalid');
  }
  return {
    id,
    principal,
    url,
    secret,
    createdAt,
    name: entry.name,
    arguments: entry.arguments,
    refreshBefore: entry.refreshBefore,
  };
}

// Subscriptions are deliberately synchronous: the file is small, updates are rare, and sync
// mutation makes the read-modify-write of subscribe/unsubscribe atomic in one event loop turn.
export class SubscriptionStore {
  readonly file: string;
  private subscriptions: StoredSubscription[] | undefined;

  constructor(file: string) {
    this.file = file;
  }

  private load(): StoredSubscription[] {
    if (this.subscriptions) return this.subscriptions;
    if (!existsSync(this.file)) {
      this.subscriptions = [];
      return this.subscriptions;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`events state file ${this.file} is not valid JSON`, { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`events state file ${this.file} is not an object`);
    }
    const file = parsed as Partial<StoreFile>;
    if (file.version !== STORE_VERSION || !Array.isArray(file.subscriptions)) {
      throw new Error(`events state file ${this.file} has an unsupported shape`);
    }
    this.subscriptions = file.subscriptions.map(parseSubscription);
    return this.subscriptions;
  }

  private save(subscriptions: readonly StoredSubscription[]) {
    const body = JSON.stringify({ version: STORE_VERSION, subscriptions });
    writePrivate(this.file, body);
  }

  list(): readonly StoredSubscription[] {
    return [...this.load()];
  }

  get(id: string): StoredSubscription | undefined {
    return this.load().find((entry) => entry.id === id);
  }

  findIdentity(
    principal: string,
    url: string,
    name: EventName,
    args: Json,
  ): StoredSubscription | undefined {
    const wanted = canonicalJson(args);
    return this.load().find(
      (entry) =>
        entry.principal === principal &&
        entry.url === url &&
        entry.name === name &&
        canonicalJson(entry.arguments) === wanted,
    );
  }

  upsert(subscription: StoredSubscription) {
    const current = this.load();
    const next = [...current];
    const index = next.findIndex((entry) => entry.id === subscription.id);
    if (index >= 0) next[index] = subscription;
    else {
      if (next.length >= MAX_SUBSCRIPTIONS) throw new Error('too many subscriptions');
      next.push(subscription);
    }
    this.save(next);
    this.subscriptions = next;
  }

  remove(id: string): boolean {
    const current = this.load();
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) return false;
    this.save(next);
    this.subscriptions = next;
    return true;
  }
}

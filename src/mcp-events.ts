import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { BridgeConfig } from './config.ts';
import { DaemonEventStream } from './daemon-events.ts';
import {
  EVENT_BY_NAME,
  EVENT_CATALOG,
  deliveryFor,
  parseTaskStateEvent,
  type DeliveryEvent,
  type EventName,
  type TaskStateEvent,
} from './event-catalog.ts';
import { DeliveryQueues, type RetryPolicy } from './event-delivery.ts';
import { SubscriptionStore, canonicalJson, type StoredSubscription } from './event-store.ts';
import { VerificationCache, verifyCallback } from './event-verify.ts';
import { inAllowedRoot } from './scope.ts';
import { buildToolScope, type ToolScope } from './tools-shared.ts';
import type { Json } from './daemon.ts';
import {
  CallbackError,
  parseWebhookSecret,
  postCallback,
  validateCallbackUrl,
  type CallbackSender,
} from './webhook.ts';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10_000;
const DELIVERY_ATTEMPTS = 5;
const DELIVERY_BASE_DELAY_MS = 500;
const DELIVERY_MAX_DELAY_MS = 8000;

export type ListParams = { cursor?: string | null };
export type SubscribeParams = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: { mode: 'webhook'; url: string; secret?: string };
  cursor?: string | null;
  ttlMs?: number | null;
};
export type UnsubscribeParams = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: { mode: 'webhook'; url: string; secret?: string };
};

export type EventServiceOptions = {
  sender?: CallbackSender;
  now?: () => Date;
  delivery?: Partial<RetryPolicy>;
};

const invalidParams = (message: string) => new ProtocolError(-32602, message);
const DELIVERY_KEYS = ['mode', 'url', 'secret'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Stable for one daemon lifecycle transition, so a repeated subscription or a duplicate daemon
// frame collapses onto the same webhook-id and the per-subscription dedup window catches it.
function eventIdFor(event: TaskStateEvent) {
  const identity = [event.taskId, event.sequence ?? '', event.status, event.occurredAt].join('\0');
  return `evt_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function callbackUrl(value: unknown) {
  if (typeof value !== 'string') throw invalidParams('delivery.url must be a string');
  try {
    return validateCallbackUrl(value).href;
  } catch {
    throw invalidParams('delivery.url must be an HTTPS URL without credentials');
  }
}

function deliverySecret(value: unknown, required: boolean) {
  if (required) {
    if (typeof value !== 'string' || !parseWebhookSecret(value)) {
      throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24-64 bytes');
    }
    return value;
  }
  if (value !== undefined && typeof value !== 'string') {
    throw invalidParams('delivery.secret must be a string');
  }
  return typeof value === 'string' ? value : '';
}

function directoryArgument(directory: unknown): Json {
  if (directory === undefined) return {};
  if (typeof directory !== 'string' || directory.trim() === '' || !path.isAbsolute(directory)) {
    throw invalidParams('arguments.directory must be an absolute path');
  }
  return { directory: path.normalize(directory) };
}

export class EventService {
  private readonly config: BridgeConfig;
  private readonly store: SubscriptionStore;
  private readonly sender: CallbackSender;
  private readonly now: () => Date;
  private readonly queues: DeliveryQueues;
  private readonly verified = new VerificationCache();
  private readonly scopes = new Map<string, ToolScope>();
  private readonly verifyCacheTtlMs: number;
  private readonly verifyTimeoutMs: number;
  private stream: DaemonEventStream | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(config: BridgeConfig, options: EventServiceOptions = {}) {
    this.config = config;
    this.store = new SubscriptionStore(
      config.eventsStatePath ?? path.join(path.dirname(config.daemonSocket), 'events.json'),
    );
    this.sender = options.sender ?? postCallback;
    this.now = options.now ?? (() => new Date());
    this.verifyCacheTtlMs = VERIFY_CACHE_TTL_MS;
    this.verifyTimeoutMs = VERIFY_TIMEOUT_MS;
    this.queues = new DeliveryQueues(this.sender, {
      attempts: DELIVERY_ATTEMPTS,
      baseDelayMs: DELIVERY_BASE_DELAY_MS,
      maxDelayMs: DELIVERY_MAX_DELAY_MS,
      now: this.now,
      ...options.delivery,
    });
    // Persisted subscriptions must be matchable before the first request after a restart. Both
    // surfaces share the same workspace allowlist, but only the configured ones get a principal.
    const scope = buildToolScope(config);
    this.scopes.set('bridge', scope);
    if (config.gateway) this.scopes.set('gateway', scope);
  }

  registerPrincipal(principal: string, scope: ToolScope) {
    this.scopes.set(principal, scope);
  }

  // Existing subscriptions must resume after a restart without waiting for a new subscribe.
  start() {
    try {
      if (this.store.list().length > 0) this.ensureStream();
    } catch (error) {
      console.error(
        'MCP events state could not be loaded; event delivery is paused:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  close() {
    this.stream?.stop();
    this.stream = null;
    this.queues.close();
  }

  list(params: ListParams) {
    if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
      throw invalidParams('unknown events cursor');
    }
    return { events: EVENT_CATALOG };
  }

  async subscribe(params: SubscribeParams, principal: string): Promise<Json> {
    const name = this.eventName(params.name);
    if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
      throw invalidParams('unknown events cursor');
    }
    const scope = this.scope(principal);
    const args = await this.arguments(params.arguments, scope);
    const delivery = this.delivery(params.delivery, true);
    const id = this.subscriptionId(principal, delivery.url, name, args);
    const existing = this.store.findIdentity(principal, delivery.url, name, args);
    const secretChanged = Boolean(existing && existing.secret !== delivery.secret);
    if (!existing || secretChanged) {
      await this.verify(principal, delivery.url, delivery.secret, id, secretChanged);
    }
    const createdAt = existing?.createdAt ?? this.now().toISOString();
    const subscription: StoredSubscription = {
      id,
      principal,
      name,
      createdAt,
      arguments: args,
      url: delivery.url,
      secret: delivery.secret,
      refreshBefore: this.expiration(params.ttlMs),
    };
    this.store.upsert(subscription);
    this.ensureStream();
    return { id, refreshBefore: subscription.refreshBefore, cursor: null, truncated: false };
  }

  unsubscribe(params: UnsubscribeParams, principal: string): Json {
    const name = this.eventName(params.name);
    const scope = this.scope(principal);
    const args = this.argumentsSync(params.arguments, scope);
    const delivery = this.delivery(params.delivery, false);
    this.store.remove(this.subscriptionId(principal, delivery.url, name, args));
    return {};
  }

  // The monitor feeds every daemon event here. Ingest is serialized so task lifecycle order is
  // preserved even when allowlist checks resolve symlinks asynchronously.
  ingest(value: unknown): Promise<void> {
    const run = this.chain.then(
      () => this.dispatch(value),
      () => this.dispatch(value),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async dispatch(value: unknown) {
    const event = parseTaskStateEvent(value);
    const delivery = event && deliveryFor(event);
    if (!event || !delivery) return;
    const eventId = eventIdFor(event);
    const now = this.now().getTime();
    for (const subscription of this.store.list()) {
      if (!(await this.matches(subscription, event, delivery, now))) continue;
      this.queues.enqueue(subscription, delivery, eventId, event.occurredAt);
    }
  }

  private async matches(
    subscription: StoredSubscription,
    event: { directory: string },
    delivery: DeliveryEvent,
    now: number,
  ) {
    if (subscription.name !== delivery.name) return false;
    if (subscription.refreshBefore && Date.parse(subscription.refreshBefore) <= now) return false;
    const scope = this.scopes.get(subscription.principal);
    if (!scope || !(await inAllowedRoot(scope.allowDirectories, event.directory))) return false;
    const filter = subscription.arguments.directory;
    return typeof filter !== 'string' || inAllowedRoot([filter], event.directory);
  }

  private async verify(
    principal: string,
    url: string,
    secret: string,
    id: string,
    secretChanged: boolean,
  ) {
    const key = parseWebhookSecret(secret);
    if (!key)
      throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24-64 bytes');
    const cacheKey = createHash('sha256').update(`${principal}\n${url}\n${secret}`).digest('hex');
    const now = this.now().getTime();
    if (!secretChanged && this.verified.get(cacheKey, now)) return;
    try {
      await verifyCallback(
        { url, secret: key, subscriptionId: id },
        { sender: this.sender, timeoutMs: this.verifyTimeoutMs },
      );
    } catch (error) {
      const reason = error instanceof CallbackError ? error.reason : 'challenge_failed';
      throw new ProtocolError(-32015, `callback verification failed (${reason})`, { reason });
    }
    this.verified.set(cacheKey, now + this.verifyCacheTtlMs);
  }

  private eventName(value: string): EventName {
    if (!EVENT_BY_NAME.has(value as EventName)) throw invalidParams('unknown event name');
    return value as EventName;
  }

  private scope(principal: string): ToolScope {
    const scope = this.scopes.get(principal);
    if (!scope) throw invalidParams('events are not available on this surface');
    return scope;
  }

  private argumentsSync(value: Record<string, unknown> | undefined, scope: ToolScope): Json {
    if (value !== undefined && !isRecord(value)) throw invalidParams('arguments must be an object');
    const args = value ?? {};
    const unknown = Object.keys(args).find((key) => key !== 'directory');
    if (unknown) throw invalidParams(`unknown argument "${unknown}"`);
    if (!scope.allowDirectories.length) throw invalidParams('workspace allowlist required');
    return directoryArgument(args.directory);
  }

  private async arguments(
    value: Record<string, unknown> | undefined,
    scope: ToolScope,
  ): Promise<Json> {
    const args = this.argumentsSync(value, scope);
    const directory = args.directory;
    if (
      typeof directory === 'string' &&
      !(await inAllowedRoot(scope.allowDirectories, directory))
    ) {
      throw invalidParams('arguments.directory is not in an allowed workspace');
    }
    return args;
  }

  private delivery(
    value: SubscribeParams['delivery'] | UnsubscribeParams['delivery'],
    requireSecret: boolean,
  ): { url: string; secret: string } {
    if (!isRecord(value) || value.mode !== 'webhook') {
      throw invalidParams('delivery.mode must be webhook');
    }
    const unknown = Object.keys(value).find((key) => !DELIVERY_KEYS.includes(key));
    if (unknown) throw invalidParams(`unknown delivery field "${unknown}"`);
    return { url: callbackUrl(value.url), secret: deliverySecret(value.secret, requireSecret) };
  }

  private expiration(ttlMs: number | null | undefined): string | null {
    if (ttlMs === null) return null;
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 0)) {
      throw invalidParams('ttlMs must be a non-negative integer or null');
    }
    const granted = Math.min(Math.max(ttlMs ?? DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
    return new Date(this.now().getTime() + granted).toISOString();
  }

  private subscriptionId(principal: string, url: string, name: EventName, args: Json) {
    const identity = canonicalJson({ principal, url, name, arguments: args });
    return `sub_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
  }

  private ensureStream() {
    if (this.stream) return;
    this.stream = new DaemonEventStream({
      socket: this.config.daemonSocket,
      onEvent: (event) => {
        void this.ingest(event).catch(() => {});
      },
    });
    this.stream.start();
  }
}

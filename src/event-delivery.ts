import {
  CallbackError,
  MAX_EVENT_BYTES,
  parseWebhookSecret,
  signWebhook,
  type CallbackSender,
} from './webhook.ts';
import type { DeliveryEvent } from './event-catalog.ts';
import type { Json } from './daemon.ts';

const MAX_RECENT_EVENT_IDS = 500;
const MAX_PENDING_PER_SUBSCRIPTION = 100;

export type DeliverySubscription = { id: string; url: string; secret: string };
export type RetryPolicy = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function shouldRetryStatus(status: number) {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

function isRetryableError(error: unknown) {
  return !(error instanceof CallbackError) || error.reason !== 'challenge_failed';
}

type AttemptOutcome = 'accepted' | 'drop' | 'retry';
type DeliveryBody = { eventId: string; body: string };

function classifyResponse(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410 || status === 413) return 'drop';
  return shouldRetryStatus(status) ? 'retry' : 'drop';
}

async function attemptOnce(
  sender: CallbackSender,
  target: DeliverySubscription,
  key: Buffer,
  payload: DeliveryBody,
  policy: RetryPolicy,
): Promise<AttemptOutcome> {
  const signedAt = (policy.now ?? (() => new Date()))();
  const timestamp = Math.floor(signedAt.getTime() / 1000);
  try {
    const response = await sender({
      body: payload.body,
      url: target.url,
      timeoutMs: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': payload.eventId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(key, payload.eventId, timestamp, payload.body),
        'X-MCP-Subscription-Id': target.id,
      },
    });
    return classifyResponse(response.status);
  } catch (error) {
    return isRetryableError(error) ? 'retry' : 'drop';
  }
}

async function attemptDelivery(
  sender: CallbackSender,
  target: DeliverySubscription,
  eventId: string,
  body: string,
  policy: RetryPolicy,
): Promise<boolean> {
  const key = parseWebhookSecret(target.secret);
  if (!key) return false;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const outcome = await attemptOnce(sender, target, key, { eventId, body }, policy);
    if (outcome !== 'retry') return outcome === 'accepted';
    if (attempt < policy.attempts) {
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await (policy.sleep ?? defaultSleep)(delay);
    }
  }
  return false;
}

type QueueState = { tail: Promise<void>; pending: number; seen: Set<string>; order: string[] };

// Per-subscription FIFO with bounded memory: one event in flight, a capped backlog, and a
// capped recent-id window so a repeated event cannot be delivered twice.
export class DeliveryQueues {
  private readonly sender: CallbackSender;
  private readonly policy: RetryPolicy;
  private readonly queues = new Map<string, QueueState>();
  private closed = false;

  constructor(sender: CallbackSender, policy: RetryPolicy) {
    this.sender = sender;
    this.policy = policy;
  }

  enqueue(target: DeliverySubscription, event: DeliveryEvent, eventId: string, timestamp: string) {
    if (this.closed) return;
    const state = this.state(target.id);
    if (state.seen.has(eventId)) return;
    state.seen.add(eventId);
    state.order.push(eventId);
    if (state.order.length > MAX_RECENT_EVENT_IDS) {
      const expired = state.order.shift();
      if (expired) state.seen.delete(expired);
    }
    if (state.pending >= MAX_PENDING_PER_SUBSCRIPTION) return;
    const body = JSON.stringify({
      eventId,
      timestamp,
      name: event.name,
      data: event.data as Json,
      cursor: null,
    });
    if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return;
    state.pending += 1;
    const run = () => attemptDelivery(this.sender, target, eventId, body, this.policy);
    state.tail = state.tail.then(run, run).then(
      () => {
        state.pending -= 1;
      },
      () => {
        state.pending -= 1;
      },
    );
  }

  private state(id: string): QueueState {
    const existing = this.queues.get(id);
    if (existing) return existing;
    const created: QueueState = {
      tail: Promise.resolve(),
      pending: 0,
      seen: new Set(),
      order: [],
    };
    this.queues.set(id, created);
    return created;
  }

  async waitForIdle() {
    for (;;) {
      const tails = [...this.queues.values()].filter((state) => state.pending > 0);
      if (tails.length === 0) return;
      await Promise.all(tails.map((state) => state.tail));
    }
  }

  close() {
    this.closed = true;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  bridgeConfig,
  mcpUrl,
  okReply,
  removeDir,
  reply,
  rpc,
  send,
  stubDaemon,
  tempDir,
} from './helpers.ts';
import { startSurfaces } from '../src/server.ts';
import { DaemonEventStream } from '../src/daemon-events.ts';
import { EventService } from '../src/mcp-events.ts';
import {
  CallbackError,
  parseWebhookSecret,
  signWebhook,
  type CallbackRequest,
  type CallbackResponse,
} from '../src/webhook.ts';

const SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const CALLBACK = 'https://hooks.example.com/mcp-events/callback';
const DAEMON_SUBSCRIPTION = 'daemon-sub';
const BASE_TIME = Date.UTC(2026, 9, 26, 12, 0, 0);
const PROTOCOL_VERSION = '2026-07-28';
const COMPLETED = 'task.completed';
const FAILED = 'task.failed';
const CANCELLED = 'task.cancelled';

function modernRpc(method: string, params: Record<string, unknown> = {}) {
  const name = typeof params.name === 'string' ? params.name : undefined;
  return {
    body: JSON.stringify({
      method,
      jsonrpc: '2.0',
      id: 1,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
    headers: {
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(name === undefined ? {} : { 'Mcp-Name': name }),
    },
  };
}

type EventReply = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { reason?: string } };
};

type Handler = (request: CallbackRequest) => CallbackResponse | Promise<CallbackResponse>;

function challengeReply(request: CallbackRequest): CallbackResponse {
  const body = JSON.parse(request.body) as { challenge?: string };
  return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
}

function eventReply(request: CallbackRequest): CallbackResponse {
  assert.notEqual(JSON.parse(request.body).type, 'verification');
  return { status: 200, body: '{}' };
}

function mixedReply(request: CallbackRequest): CallbackResponse {
  return JSON.parse(request.body).type === 'verification'
    ? challengeReply(request)
    : { status: 200, body: '{}' };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function taskState(taskId: string, status: string, directory: string, sequence: number) {
  return {
    type: 'task.state',
    previousStatus: 'running',
    occurredAt: new Date(BASE_TIME + sequence * 1000).toISOString(),
    taskId,
    directory,
    status,
    sequence,
  };
}

function eventBodies(requests: readonly CallbackRequest[]) {
  return requests
    .map((request) => JSON.parse(request.body) as Record<string, unknown>)
    .filter((body) => body.type !== 'verification');
}

async function fixture() {
  const workspace = realpathSync(tempDir('tf-events-workspace-'));
  const stateDir = tempDir('tf-events-state-');
  const daemon = await stubDaemon((request) =>
    okReply(
      request,
      request.method === 'event.subscribe'
        ? { subscriptionId: DAEMON_SUBSCRIPTION }
        : { tasks: [] },
    ),
  );
  const requests: CallbackRequest[] = [];
  let handler: Handler = challengeReply;
  let tick = 0;
  const sender = async (request: CallbackRequest) => {
    requests.push(request);
    return handler(request);
  };
  const config = bridgeConfig({
    daemonSocket: daemon.socket,
    allowDirectories: [workspace],
    eventsStatePath: path.join(stateDir, 'events.json'),
  });
  const events = new EventService(config, {
    sender,
    now: () => {
      const current = BASE_TIME + tick * 1000;
      tick += 1;
      return new Date(current);
    },
    delivery: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} },
  });
  const surfaces = await startSurfaces(config, {}, events);
  const url = mcpUrl(surfaces.bridge);
  const invoke = async (
    method: string,
    params: Record<string, unknown> = {},
    options: { token?: string | null } = {},
  ) => {
    const request = modernRpc(method, params);
    const sent = await send(url, request.body, { ...options, headers: request.headers });
    assert.equal(sent.status, 200, sent.text);
    return reply(sent) as EventReply;
  };
  const subscribe = (overrides: Record<string, unknown> = {}) =>
    invoke('events/subscribe', {
      name: COMPLETED,
      arguments: {},
      delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET },
      cursor: null,
      ...overrides,
    });
  const close = async () => {
    await surfaces.close();
    await daemon.close();
    removeDir(workspace);
    removeDir(stateDir);
  };
  return {
    setHandler: (next: Handler) => {
      handler = next;
    },
    storePath: path.join(stateDir, 'events.json'),
    config,
    daemon,
    events,
    invoke,
    requests,
    stateDir,
    subscribe,
    url,
    workspace,
    close,
  };
}

test('server/discover advertises events and the 2026-07-28 protocol version', async () => {
  const app = await fixture();
  try {
    const discover = await app.invoke('server/discover');
    assert.ok(discover.result, JSON.stringify(discover));
    const result = discover.result as {
      supportedVersions: string[];
      capabilities: { events?: Record<string, never>; tools?: unknown };
    };
    assert.ok(result.supportedVersions.includes('2026-07-28'));
    assert.deepEqual(result.capabilities.events, {});
    assert.ok(result.capabilities.tools);

    const listed = await app.invoke('events/list');
    const events = listed.result?.events as { name: string; delivery: string[] }[];
    assert.deepEqual(
      events.map((entry) => entry.name),
      [COMPLETED, FAILED, CANCELLED],
    );
    assert.ok(events.every((entry) => entry.delivery.includes('webhook')));
  } finally {
    await app.close();
  }
});

test('the events methods stay behind the same bearer-token guard as the tools', async () => {
  const app = await fixture();
  try {
    const unauthorized = await send(app.url, rpc('events/list'), { token: null });
    assert.equal(unauthorized.status, 401);
  } finally {
    await app.close();
  }
});

test('subscribe verifies the callback, signs it and persists the subscription privately', async () => {
  const app = await fixture();
  try {
    const response = await app.subscribe();
    const result = response.result as { id: string; refreshBefore: string; cursor: null };
    assert.match(result.id, /^sub_[0-9a-f]{32}$/);
    assert.ok(Date.parse(result.refreshBefore) > BASE_TIME);
    assert.equal(result.cursor, null);

    assert.equal(app.requests.length, 1);
    const verification = app.requests[0];
    const body = JSON.parse(verification.body) as { type: string; challenge: string };
    assert.equal(body.type, 'verification');
    const key = parseWebhookSecret(SECRET);
    assert.ok(key);
    assert.equal(
      verification.headers['webhook-signature'],
      signWebhook(
        key,
        verification.headers['webhook-id'],
        Number(verification.headers['webhook-timestamp']),
        verification.body,
      ),
    );
    assert.equal(verification.headers['X-MCP-Subscription-Id'], result.id);

    assert.equal(statSync(app.storePath).mode & 0o777, 0o600);
    const stored = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(app.storePath, 'utf8')),
    ) as { subscriptions: { id: string; url: string }[] };
    assert.equal(stored.subscriptions[0].id, result.id);
    assert.equal(stored.subscriptions[0].url, CALLBACK);

    const repeated = await app.subscribe();
    assert.equal((repeated.result as { id: string }).id, result.id);
    assert.equal(app.requests.length, 1, 'an identical subscription must not re-challenge');
  } finally {
    await app.close();
  }
});

test('invalid secrets and failed callback challenges return the documented JSON-RPC errors', async () => {
  const app = await fixture();
  try {
    const badSecret = await app.subscribe({
      delivery: { mode: 'webhook', url: CALLBACK, secret: 'not-a-secret' },
    });
    assert.equal(badSecret.error?.code, -32602);

    const badCursor = await app.subscribe({ cursor: 'saved-cursor' });
    assert.equal(badCursor.error?.code, -32602);

    app.setHandler(() => ({ status: 200, body: JSON.stringify({ challenge: 'wrong' }) }));
    const failed = await app.subscribe({ name: FAILED });
    assert.equal(failed.error?.code, -32015);
    assert.equal(failed.error?.data?.reason, 'challenge_failed');

    app.setHandler(() => ({ status: 503, body: '' }));
    const unavailable = await app.subscribe({ name: CANCELLED });
    assert.equal(unavailable.error?.code, -32015);
    assert.equal(unavailable.error?.data?.reason, 'http_5xx');

    app.setHandler(() => {
      throw new CallbackError('timeout', 'test timeout');
    });
    const timeout = await app.subscribe({ name: COMPLETED, arguments: {} });
    assert.equal(timeout.error?.data?.reason, 'timeout');
  } finally {
    await app.close();
  }
});

test('task states map to completed, failed and cancelled without inventing input-needed', async () => {
  const app = await fixture();
  try {
    app.setHandler(mixedReply);
    for (const name of [COMPLETED, FAILED, CANCELLED]) {
      const response = await app.subscribe({ name });
      assert.ok(response.result, JSON.stringify(response.error));
    }
    assert.equal(app.requests.length, 1, 'repeated URLs with the same secret reuse verification');

    await app.events.ingest(taskState('task-a', 'queued', app.workspace, 1));
    await app.events.ingest(taskState('task-a', 'running', app.workspace, 2));
    await app.events.ingest(taskState('task-b', 'done', app.workspace, 3));
    await app.events.ingest(taskState('task-c', 'crashed', app.workspace, 4));
    await app.events.ingest(taskState('task-d', 'unknown', app.workspace, 5));
    await app.events.ingest(taskState('task-e', 'cancelled', app.workspace, 6));
    await app.events.ingest(
      taskState('task-f', 'done', path.join(app.stateDir, 'outside-workspace'), 7),
    );

    await waitFor(() => eventBodies(app.requests).length === 4, 'four terminal events');
    assert.deepEqual(
      eventBodies(app.requests).map((body) => [
        body.name,
        (body.data as { status: string }).status,
      ]),
      [
        [COMPLETED, 'done'],
        [FAILED, 'crashed'],
        [FAILED, 'unknown'],
        [CANCELLED, 'cancelled'],
      ],
    );
  } finally {
    await app.close();
  }
});

test('a directory argument narrows delivery to that workspace subtree', async () => {
  const app = await fixture();
  try {
    app.setHandler(mixedReply);
    const appDir = path.join(app.workspace, 'app');
    const otherDir = path.join(app.workspace, 'other');
    mkdirSync(appDir);
    mkdirSync(otherDir);
    const response = await app.subscribe({ arguments: { directory: appDir } });
    assert.ok(response.result, JSON.stringify(response.error));

    await app.events.ingest(taskState('task-out', 'done', otherDir, 1));
    await app.events.ingest(taskState('task-in', 'done', appDir, 2));
    await waitFor(() => eventBodies(app.requests).length === 1, 'filtered event');
    assert.equal((eventBodies(app.requests)[0].data as { taskId: string }).taskId, 'task-in');
  } finally {
    await app.close();
  }
});

test('transient delivery failures retry with the same event id and a fresh signature', async () => {
  const app = await fixture();
  try {
    assert.ok((await app.subscribe()).result);
    let attempts = 0;
    app.setHandler(() => {
      attempts += 1;
      return attempts < 3 ? { status: 500, body: '' } : { status: 200, body: '{}' };
    });
    await app.events.ingest(taskState('task-retry', 'done', app.workspace, 1));
    await waitFor(() => attempts === 3, 'three delivery attempts');
    const events = app.requests.filter(
      (request) => JSON.parse(request.body).type !== 'verification',
    );
    assert.equal(events.length, 3);
    assert.equal(new Set(events.map((request) => request.headers['webhook-id'])).size, 1);
    assert.equal(new Set(events.map((request) => request.headers['webhook-timestamp'])).size, 3);
    assert.equal(new Set(events.map((request) => request.headers['webhook-signature'])).size, 3);
  } finally {
    await app.close();
  }
});

test('a 410 response is terminal, and a duplicate event id is delivered once', async () => {
  const app = await fixture();
  try {
    assert.ok((await app.subscribe()).result);
    let attempts = 0;
    app.setHandler(() => {
      attempts += 1;
      return { status: attempts === 1 ? 410 : 200, body: '' };
    });
    const event = taskState('task-gone', 'done', app.workspace, 1);
    await app.events.ingest(event);
    await waitFor(() => attempts === 1, 'first attempt');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempts, 1);

    app.setHandler(eventReply);
    await app.events.ingest(taskState('task-once', 'done', app.workspace, 2));
    await app.events.ingest(taskState('task-once', 'done', app.workspace, 2));
    await waitFor(() => eventBodies(app.requests).length === 2, 'one duplicate-collapsed event');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(eventBodies(app.requests).length, 2);
  } finally {
    await app.close();
  }
});

test('unsubscribe removes the identity so later matching events are not delivered', async () => {
  const app = await fixture();
  try {
    assert.ok((await app.subscribe()).result);
    const removed = await app.invoke('events/unsubscribe', {
      name: COMPLETED,
      arguments: {},
      delivery: { mode: 'webhook', url: CALLBACK },
    });
    assert.ok(removed.result, JSON.stringify(removed.error));

    app.setHandler(eventReply);
    await app.events.ingest(taskState('task-after-unsubscribe', 'done', app.workspace, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(eventBodies(app.requests).length, 0);
  } finally {
    await app.close();
  }
});

test('subscriptions survive a restart and deliver without a new subscribe call', async () => {
  const app = await fixture();
  try {
    assert.ok((await app.subscribe()).result);
    app.setHandler(eventReply);
    await app.events.ingest(taskState('task-first', 'done', app.workspace, 1));
    await waitFor(() => eventBodies(app.requests).length === 1, 'first delivery');
    await app.events.close();

    const delivered: string[] = [];
    const restarted = new EventService(app.config, {
      sender: async (request) => {
        delivered.push(request.body);
        return { status: 200, body: '{}' };
      },
      delivery: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
    });
    await restarted.ingest(taskState('task-second', 'done', app.workspace, 2));
    await waitFor(() => delivered.length === 1, 'delivery after restart');
    assert.equal(JSON.parse(delivered[0]).name, COMPLETED);
    restarted.close();
  } finally {
    await app.close();
  }
});

test('the daemon event stream subscribes to all directories and forwards event frames', async () => {
  const event = taskState('task-stream', 'done', path.join(process.cwd(), 'virtual-workspace'), 1);
  const daemon = await stubDaemon(
    (request) =>
      okReply(request, { subscriptionId: DAEMON_SUBSCRIPTION }) +
      JSON.stringify({
        version: 1,
        type: 'event',
        subscriptionId: DAEMON_SUBSCRIPTION,
        event,
      }) +
      '\n',
  );
  const seen: unknown[] = [];
  const stream = new DaemonEventStream({
    socket: daemon.socket,
    onEvent: (value) => seen.push(value),
    baseDelayMs: 2,
  });
  try {
    stream.start();
    await waitFor(() => seen.length === 1, 'daemon event');
    assert.deepEqual(seen[0], event);
    assert.deepEqual(daemon.calls[0].params, { all: true });
  } finally {
    stream.stop();
    await daemon.close();
  }
});

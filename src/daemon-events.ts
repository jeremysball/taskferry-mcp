import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { MAX_REQUEST_BYTES } from './transport.ts';

export type DaemonEventStreamOptions = {
  socket: string;
  onEvent: (event: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

function parseMessage(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function subscriptionIdFromReply(
  message: Record<string, unknown>,
  requestId: string,
): string | null {
  if (message.id !== requestId || message.version !== 1 || message.ok !== true) return null;
  const result = message.result as { subscriptionId?: unknown } | undefined;
  return typeof result?.subscriptionId === 'string' ? result.subscriptionId : null;
}

function isEventMessage(message: Record<string, unknown>, subscriptionId: string): boolean {
  if (
    message.version !== 1 ||
    message.type !== 'event' ||
    message.subscriptionId !== subscriptionId
  ) {
    return false;
  }
  return typeof message.event === 'object' && message.event !== null;
}

// One long-lived daemon connection subscribed to every directory. Reconnects resubscribe from
// scratch: TaskFerry's event protocol has no cursor or replay, so events during an outage are
// genuinely lost and the bridge must not pretend otherwise.
export class DaemonEventStream {
  private readonly options: DaemonEventStreamOptions;
  private socket: net.Socket | null = null;
  private requestId: string | null = null;
  private subscriptionId: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private delay: number;

  constructor(options: DaemonEventStreamOptions) {
    this.options = options;
    this.delay = options.baseDelayMs ?? 500;
  }

  get connected() {
    return this.socket !== null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.delay = this.options.baseDelayMs ?? 500;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    this.requestId = null;
    this.subscriptionId = null;
    socket?.destroy();
  }

  private schedule() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.delay);
    this.retry.unref?.();
    this.delay = Math.min(this.delay * 2, this.options.maxDelayMs ?? 30_000);
  }

  private handleLine(line: string) {
    const message = parseMessage(line);
    const requestId = this.requestId;
    if (!message || !requestId) {
      this.disconnect();
      return;
    }
    const subscriptionId = subscriptionIdFromReply(message, requestId);
    if (message.id === requestId) {
      if (!subscriptionId) {
        this.disconnect();
        return;
      }
      this.subscriptionId = subscriptionId;
      this.delay = this.options.baseDelayMs ?? 500;
      return;
    }
    if (this.subscriptionId && isEventMessage(message, this.subscriptionId)) {
      this.emit(message.event);
    }
  }

  private emit(event: unknown) {
    try {
      this.options.onEvent(event);
    } catch {
      // A consumer failure cannot break the daemon subscription.
    }
  }

  private disconnect() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.schedule();
  }

  private connect() {
    if (this.stopped) return;
    const socket = net.createConnection(this.options.socket);
    this.requestId = randomUUID();
    this.subscriptionId = null;
    let buffer = '';
    this.socket = socket;

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({
          version: 1,
          id: this.requestId,
          method: 'event.subscribe',
          params: { all: true },
        }) + '\n',
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        this.disconnect();
        return;
      }
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(line);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => this.disconnect());
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.schedule();
    });
  }
}

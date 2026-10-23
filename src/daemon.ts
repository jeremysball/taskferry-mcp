import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS } from './config.ts';

const MAX_BYTES = 1024 * 1024;

export type Json = Record<string, unknown>;

// A failure the daemon itself reported. `code` is the daemon's error code, when it sent one.
export class DaemonError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}

type DaemonReply = {
  version?: unknown;
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

// Resolves to the reply's result when `line` answers request `id`, to
// undefined when it answers another request, and throws on a bad reply.
function readReply(line: string, id: string): { result: unknown } | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error('invalid daemon JSON');
  }
  if (typeof reply !== 'object' || reply === null) throw new Error('invalid daemon reply');
  const r = reply as DaemonReply;
  if (r.id !== id) return undefined;
  if (r.version !== 1) throw new Error('unexpected daemon protocol version');
  if (r.ok !== true) {
    const code = typeof r.error?.code === 'string' ? r.error.code : undefined;
    throw new DaemonError(String(r.error?.message || 'daemon rejected request'), code);
  }
  return { result: r.result };
}

// One request over the daemon's newline-delimited JSON protocol (`{version: 1, id, method,
// params}` in, `{version: 1, ok, id, result | error}` out). One connection per call.
export function callDaemon(
  target: string | { daemonSocket: string; limits: { daemonTimeoutMs: number } },
  method: string,
  params: Json,
  timeout = typeof target === 'string'
    ? DEFAULT_LIMITS.daemonTimeoutMs
    : target.limits.daemonTimeoutMs,
): Promise<unknown> {
  const socketPath = typeof target === 'string' ? target : target.daemonSocket;
  return new Promise((resolve, reject) => {
    const id = randomUUID(),
      socket = net.createConnection(socketPath);
    let data = '',
      finished = false;
    const finish = (err?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const drain = () => {
      let n = data.indexOf('\n');
      while (n >= 0) {
        const line = data.slice(0, n);
        data = data.slice(n + 1);
        const reply = readReply(line, id);
        if (reply) {
          finish(undefined, reply.result);
          return;
        }
        n = data.indexOf('\n');
      }
    };
    socket.setTimeout(timeout, () => finish(new Error('daemon timeout')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error('daemon disconnected before response')));
    socket.on('connect', () =>
      socket.write(JSON.stringify({ version: 1, id, method, params }) + '\n'),
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BYTES) {
        finish(new Error('daemon response too large'));
        return;
      }
      try {
        drain();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

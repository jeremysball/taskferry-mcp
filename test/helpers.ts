import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LIMITS, type BridgeConfig } from '../src/config.ts';
import type { ToolDeps } from '../src/tools.ts';
import { createBridge } from '../src/server.ts';
export { TASK_STATUS } from '../src/tools-shared.ts';

export const TOKEN = 'correct-secret';
export const HEALTH = 'taskferry_health';
export const STATUS_TOOL = 'taskferry_status';

export type Call = { id: string; method: string; params: Record<string, unknown> };
export type Reply = {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    serverInfo?: { name: string };
    instructions?: string;
    capabilities?: { tools?: { listChanged?: boolean } };
    tools?: {
      name: string;
      inputSchema: { additionalProperties?: boolean };
      annotations?: { readOnlyHint?: boolean };
    }[];
  };
  error?: { code: number; message: string };
  id?: unknown;
};

export const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

const SKILL_ROOT_PARTS = [
  'skills/searching-the-web',
  'skills/using-chhoto',
  'fleet-skills',
  'plugins/cache',
];

// A canonical temp skill root holding every path a profile can mount. `realpathSync` keeps the
// literal expected paths stable on hosts where the temp directory is itself a symlink.
export function createSkillRoot() {
  const dir = realpathSync(tempDir('tf-skills-'));
  for (const part of SKILL_ROOT_PARTS) mkdirSync(path.join(dir, part), { recursive: true });
  return dir;
}

// The single source of test bridge config. Production defaults come from resolveConfig; this
// factory exists so a new required field updates every test once.
export function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    daemonSocket: '',
    token: TOKEN,
    allowDirectories: [],
    allowModels: [],
    allowRoBinds: [],
    skillProfile: 'worker',
    skillRoot: path.join(tmpdir(), 'tf-skill-root-unused'),
    serverRoBinds: [],
    listen: { kind: 'tcp', port: 0 },
    ...DEFAULT_LIMITS,
    ...overrides,
  };
}

export const listenOnSocket = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve) => server.listen(socketPath, resolve));
export const stop = (server: net.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

// Starts `server` on a free loopback TCP port and resolves to its /mcp URL.
export async function serve(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

function writeChunks(c: net.Socket, out: string | Buffer[]) {
  if (typeof out === 'string') c.write(out);
  else out.forEach((part, i) => setTimeout(() => c.write(part), i));
}

// A daemon that answers every request line with whatever `reply` returns: one write for a
// string, one delayed write per element for a list of chunks.
export async function stubDaemon(reply: (req: Call) => string | Buffer[]) {
  const dir = tempDir('tf-stub-');
  const socket = path.join(dir, 'daemon.sock');
  const calls: Call[] = [];
  const server = net.createServer((c) => {
    let buffer = '';
    c.on('data', (chunk) => {
      buffer += chunk.toString();
      let n = buffer.indexOf('\n');
      while (n >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        n = buffer.indexOf('\n');
        if (!line) continue;
        const req: Call = JSON.parse(line);
        calls.push(req);
        writeChunks(c, reply(req));
      }
    });
  });
  await listenOnSocket(server, socket);
  const close = async () => {
    await stop(server);
    removeDir(dir);
  };
  return { dir, socket, calls, close };
}

export const okReply = (req: Call, result: unknown) =>
  JSON.stringify({ version: 1, id: req.id, ok: true, result }) + '\n';

export const daemonError = (id: string, code: string, message: string) =>
  JSON.stringify({
    version: 1,
    ok: false,
    error: { code, message, help: '', detail: message },
    id,
  }) + '\n';

// Starts a bridge on a free loopback port in front of `daemonSocket` and resolves to its /mcp URL.
// Unless the caller supplies `skillRoot`, the bridge gets a temp root holding every profile path,
// and that root is removed when the bridge closes.
export async function startBridge(
  daemonSocket: string,
  overrides: Partial<BridgeConfig> = {},
  deps: Partial<ToolDeps> = {},
) {
  const ownsSkillRoot = overrides.skillRoot === undefined;
  const skillRoot = overrides.skillRoot ?? createSkillRoot();
  const bridge = createBridge(
    bridgeConfig({
      ...overrides,
      daemonSocket,
      skillRoot,
      listen: overrides.listen ?? { kind: 'tcp', port: 0 },
    }),
    deps,
  );
  const url = await serve(bridge);
  return {
    url,
    skillRoot,
    close: async () => {
      await stop(bridge);
      if (ownsSkillRoot) removeDir(skillRoot);
    },
  };
}

// A daemon that answers task.list and everything else with a canned result, splitting every
// reply across two writes so the bridge has to reassemble it.
export async function fixture(overrides: Partial<BridgeConfig> = {}) {
  const daemon = await stubDaemon((req) => {
    const payload = okReply(req, req.method === 'task.list' ? { tasks: [] } : { healthy: true });
    return [Buffer.from(payload.slice(0, 6)), Buffer.from(payload.slice(6))];
  });
  const bridge = await startBridge(daemon.socket, { allowDirectories: [daemon.dir], ...overrides });
  const close = async () => {
    await bridge.close();
    await daemon.close();
  };
  return {
    calls: daemon.calls,
    dir: daemon.dir,
    url: bridge.url,
    skillRoot: bridge.skillRoot,
    close,
  };
}

export const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
export const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  rpc('tools/call', { name, arguments: args });

export type Sent = { status: number; headers: http.IncomingHttpHeaders; text: string };
type SendOptions = {
  token?: string | null;
  method?: string;
  headers?: Record<string, string>;
  socketPath?: string;
};

// One HTTP request. Unlike fetch, this can set Host, and it can dial a unix socket
// (`socketPath`, with `url` supplying only the path). `token: null` sends no Authorization header.
export function send(url: string, body: string | Buffer[], options: SendOptions = {}) {
  const { token = TOKEN, method = 'POST', headers = {}, socketPath } = options;
  const all: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  };
  if (token !== null) all.authorization = `Bearer ${token}`;
  return new Promise<Sent>((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        method,
        socketPath,
        headers: all,
        path: target.pathname,
        host: target.hostname,
        port: target.port || undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    const parts = typeof body === 'string' ? [Buffer.from(body)] : body;
    parts.forEach((part, i) =>
      setTimeout(() => (i === parts.length - 1 ? req.end(part) : req.write(part)), i),
    );
  });
}

export const reply = (sent: Sent) => JSON.parse(sent.text) as Reply;
export const call = async (url: string, body: string, options: SendOptions = {}) =>
  reply(await send(url, body, options));

// Splits `payload` in the middle of its first two-byte character.
export function splitInsideChar(payload: string) {
  const bytes = Buffer.from(payload);
  const at = bytes.indexOf(0xc3) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

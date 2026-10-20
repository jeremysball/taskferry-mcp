import http from 'node:http';
import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

type Config = {
  socketPath: string;
  token: string;
  allowDirectories: string[];
  allowModels: string[];
};
const tools = [
  {
    name: 'taskferry_list',
    description: 'List tasks in the configured workspace',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'taskferry_status',
    description: 'Check task status',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskferry_result',
    description: 'Read task result',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskferry_dispatch',
    description: 'Dispatch an allowed worker',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        model: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['directory', 'model', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskferry_health',
    description: 'Check daemon connectivity',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const TASK_STATUS = 'task.status';
const MAX_BYTES = 1024 * 1024;
const INVALID_ARGUMENTS = 'invalid arguments';
const ALLOWLIST_REQUIRED = 'workspace allowlist required';

type Json = Record<string, unknown>;
type DaemonReply = {
  version?: unknown;
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};
type RpcRequest = { jsonrpc: '2.0'; method: string; id?: unknown; params?: Json };

function permitted(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Narrows to the declared string arguments: every `required` key must be a
// non-blank string, `optional` keys may be absent, and no other key is allowed.
function argsValid<R extends string, O extends string = never>(
  a: unknown,
  required: readonly R[],
  optional: readonly O[] = [],
): a is Record<R, string> & Partial<Record<O, string>> {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return false;
  const rec = a as Json;
  const allowed: readonly string[] = [...required, ...optional];
  const isString = (v: unknown): v is string => typeof v === 'string';
  return (
    Object.keys(rec).every((k) => allowed.includes(k)) &&
    required.every((k) => {
      const v = rec[k];
      return isString(v) && v.trim() !== '';
    }) &&
    optional.every((k) => rec[k] === undefined || isString(rec[k]))
  );
}

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
  if (r.ok !== true) throw new Error(String(r.error?.message || 'daemon rejected request'));
  return { result: r.result };
}

function callDaemon(
  socketPath: string,
  method: string,
  params: Json,
  timeout = 5000,
): Promise<unknown> {
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
    socket.on('data', (chunk) => {
      data += chunk.toString();
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

function isUnder(root: string, candidate: string) {
  try {
    const r = realpathSync(root),
      d = realpathSync(candidate);
    return d === r || d.startsWith(r + path.sep);
  } catch {
    return false;
  }
}
const inAllowedRoot = (c: Config, dir: string) =>
  c.allowDirectories.some((root) => isUnder(root, dir));

async function health(args: unknown, c: Config) {
  if (!argsValid(args, [])) throw new Error(INVALID_ARGUMENTS);
  return callDaemon(c.socketPath, 'system.health', {});
}

async function list(args: unknown, c: Config) {
  if (!argsValid(args, [], ['directory'])) throw new Error(INVALID_ARGUMENTS);
  if (!c.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  const directory = args.directory ?? c.allowDirectories[0];
  if (directory === undefined || !c.allowDirectories.includes(directory)) {
    throw new Error('directory denied');
  }
  return callDaemon(c.socketPath, 'task.list', { directory });
}

function scopedTaskId(args: unknown, c: Config) {
  if (!argsValid(args, ['taskId'])) throw new Error('taskId required');
  if (!c.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  return args.taskId;
}

// Reads the task's status and refuses unless its directory is inside an allowed root.
async function inScopeStatus(taskId: string, c: Config) {
  const current = await callDaemon(c.socketPath, TASK_STATUS, { taskId });
  const directory = (current as Json | null)?.directory;
  if (typeof directory !== 'string' || !inAllowedRoot(c, directory)) {
    throw new Error('task not accessible');
  }
  return current;
}

const status = async (args: unknown, c: Config) => inScopeStatus(scopedTaskId(args, c), c);

async function result(args: unknown, c: Config) {
  const taskId = scopedTaskId(args, c);
  await inScopeStatus(taskId, c);
  return callDaemon(c.socketPath, 'task.result', { taskId });
}

async function dispatch(args: unknown, c: Config) {
  if (!argsValid(args, ['directory', 'model', 'prompt'])) throw new Error(INVALID_ARGUMENTS);
  if (!c.allowDirectories.length || !c.allowModels.length) {
    throw new Error('dispatch disabled until allowlists configured');
  }
  let real: string;
  try {
    real = realpathSync(args.directory);
  } catch {
    throw new Error('directory unavailable');
  }
  if (!inAllowedRoot(c, real) || !c.allowModels.includes(args.model)) {
    throw new Error('directory or model denied');
  }
  return callDaemon(c.socketPath, 'task.dispatch', {
    directory: real,
    model: args.model,
    prompt: args.prompt,
  });
}

const handlers: Record<string, (args: unknown, c: Config) => Promise<unknown>> = {
  taskferry_health: health,
  taskferry_list: list,
  taskferry_status: status,
  taskferry_result: result,
  taskferry_dispatch: dispatch,
};
async function invokeTool(name: unknown, args: unknown, c: Config) {
  if (typeof name !== 'string' || !Object.hasOwn(handlers, name)) throw new Error('unknown tool');
  return handlers[name]?.(args, c);
}

async function callTool(params: Json | undefined, config: Config) {
  try {
    const value = await invokeTool(params?.name, params?.arguments ?? {}, config);
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (e) {
    return {
      content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
}

const rpcMethods: Record<string, (params: Json | undefined, config: Config) => unknown> = {
  initialize: () => ({
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'taskferry-mcp', version: '0.1.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools }),
  'tools/call': callTool,
};

const rpcError = (requestId: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: requestId,
  error: { code, message },
});
function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// The HTTP status to refuse with before reading the body, if any.
function refusal(req: http.IncomingMessage, config: Config) {
  if (req.url !== '/mcp') return 404;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !permitted(auth.slice(7), config.token)) return 401;
  if (req.method !== 'POST') return 405;
  if (!(req.headers['content-type'] || '').includes('application/json')) return 415;
  return undefined;
}

async function readBody(req: http.IncomingMessage) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('request too large');
  }
  return body;
}

function parseRpc(body: string): RpcRequest {
  const message = JSON.parse(body) as Partial<RpcRequest> | null;
  const paramsOk =
    message?.params === undefined ||
    (typeof message.params === 'object' && message.params !== null);
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || !paramsOk) {
    throw new Error('invalid JSON-RPC request');
  }
  return message as RpcRequest;
}

async function route(message: RpcRequest, config: Config, res: http.ServerResponse) {
  if (message.method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }
  if (!Object.hasOwn(rpcMethods, message.method)) {
    sendJson(res, 200, rpcError(message.id ?? null, -32601, 'method not found'));
    return;
  }
  const result = await rpcMethods[message.method]?.(message.params, config);
  if (message.id === undefined || message.id === null) {
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
}

export function createBridge(config: Config) {
  if (!config.token) throw new Error('bearer token required');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refused = refusal(req, config);
    if (refused === 401) {
      res.writeHead(refused).end('unauthorized');
      return;
    }
    if (refused) {
      res.writeHead(refused).end();
      return;
    }
    try {
      await route(parseRpc(await readBody(req)), config, res);
    } catch {
      sendJson(res, 400, rpcError(null, -32600, 'invalid request'));
    }
  });
}
if (process.argv[1]?.endsWith('/server.ts')) {
  const token = process.env.TASKFERRY_MCP_TOKEN || '';
  const server = createBridge({
    token,
    socketPath: process.env.TASKFERRY_SOCKET_PATH || '',
    allowDirectories: (process.env.TASKFERRY_ALLOWED_DIRECTORIES || '').split(':').filter(Boolean),
    allowModels: (process.env.TASKFERRY_ALLOWED_MODELS || '').split(',').filter(Boolean),
  });
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () =>
    console.log('TaskFerry MCP listening on loopback'),
  );
}

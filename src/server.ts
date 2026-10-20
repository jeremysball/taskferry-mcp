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
function permitted(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function argsValid(a: any, keys: string[], required: string[] = []) {
  return (
    a &&
    typeof a === 'object' &&
    !Array.isArray(a) &&
    Object.keys(a).every((k) => keys.includes(k)) &&
    required.every((k) => typeof a[k] === 'string' && a[k].trim()) &&
    keys.every((k) => a[k] === undefined || typeof a[k] === 'string')
  );
}
function callDaemon(socketPath: string, method: string, params: any, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID(),
      socket = net.createConnection(socketPath);
    let data = '',
      finished = false;
    const finish = (err?: Error, value?: any) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error('daemon timeout')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error('daemon disconnected before response')));
    socket.on('connect', () =>
      socket.write(JSON.stringify({ version: 1, id, method, params }) + '\n'),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 1024 * 1024)
        return finish(new Error('daemon response too large'));
      let n;
      while ((n = data.indexOf('\n')) >= 0) {
        const line = data.slice(0, n);
        data = data.slice(n + 1);
        let response: any;
        try {
          response = JSON.parse(line);
        } catch {
          return finish(new Error('invalid daemon JSON'));
        }
        if (response.id !== id) continue;
        if (response.version !== 1) return finish(new Error('unexpected daemon protocol version'));
        if (response.ok !== true)
          return finish(new Error(response.error?.message || 'daemon rejected request'));
        return finish(undefined, response.result);
      }
    });
  });
}
async function invokeTool(name: string, args: any, c: Config) {
  let method: string, params: any;
  if (name === 'taskferry_health') {
    if (!argsValid(args, [])) throw Error('invalid arguments');
    method = 'system.health';
    params = {};
  } else if (name === 'taskferry_list') {
    if (!argsValid(args, ['directory'])) throw Error('invalid arguments');
    if (!c.allowDirectories.length) throw Error('workspace allowlist required');
    const directory = args.directory ?? c.allowDirectories[0];
    if (!c.allowDirectories.includes(directory)) throw Error('directory denied');
    method = 'task.list';
    params = { directory };
  } else if (name === 'taskferry_status' || name === 'taskferry_result') {
    if (!argsValid(args, ['taskId'], ['taskId'])) throw Error('taskId required');
    if (!c.allowDirectories.length) throw Error('workspace allowlist required');
    const status = await callDaemon(c.socketPath, 'task.status', { taskId: args.taskId });
    if (
      typeof status?.directory !== 'string' ||
      !c.allowDirectories.some((root) => {
        try {
          const r = realpathSync(root),
            d = realpathSync(status.directory);
          return d === r || d.startsWith(r + path.sep);
        } catch {
          return false;
        }
      })
    )
      throw Error('task not accessible');
    if (name === 'taskferry_status') return status;
    method = 'task.result';
    params = { taskId: args.taskId };
  } else if (name === 'taskferry_dispatch') {
    if (!argsValid(args, ['directory', 'model', 'prompt'], ['directory', 'model', 'prompt']))
      throw Error('invalid arguments');
    if (!c.allowDirectories.length || !c.allowModels.length)
      throw Error('dispatch disabled until allowlists configured');
    let real: string;
    try {
      real = realpathSync(args.directory);
    } catch {
      throw Error('directory unavailable');
    }
    if (
      !c.allowDirectories.some((root) => {
        try {
          const r = realpathSync(root);
          return real === r || real.startsWith(r + path.sep);
        } catch {
          return false;
        }
      }) ||
      !c.allowModels.includes(args.model)
    )
      throw Error('directory or model denied');
    method = 'task.dispatch';
    params = { directory: real, model: args.model, prompt: args.prompt };
  } else throw Error('unknown tool');
  return callDaemon(c.socketPath, method, params);
}
export function createBridge(config: Config) {
  if (!config.token) throw Error('bearer token required');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !permitted(auth.slice(7), config.token)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      res.writeHead(415).end();
      return;
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1024 * 1024) throw Error('request too large');
      }
      const message = JSON.parse(body);
      if (
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        (message.params !== undefined && (typeof message.params !== 'object' || !message.params))
      )
        throw Error('invalid JSON-RPC request');
      let result: any;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'taskferry-mcp', version: '0.1.0' },
        };
      else if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      } else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'tools/call') {
        const name = message.params?.name,
          args = message.params?.arguments ?? {};
        try {
          const value = await invokeTool(name, args, config);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (e) {
          result = {
            content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
            isError: true,
          };
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32601, message: 'method not found' },
          }),
        );
        return;
      }
      if (message.id === undefined || message.id === null) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'invalid request' },
        }),
      );
    }
  });
}
if (process.argv[1]?.endsWith('/server.ts')) {
  const token = process.env.TASKFERRY_MCP_TOKEN || '';
  const server = createBridge({
    socketPath: process.env.TASKFERRY_SOCKET_PATH || '',
    token,
    allowDirectories: (process.env.TASKFERRY_ALLOWED_DIRECTORIES || '').split(':').filter(Boolean),
    allowModels: (process.env.TASKFERRY_ALLOWED_MODELS || '').split(',').filter(Boolean),
  });
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () =>
    console.log('TaskFerry MCP listening on loopback'),
  );
}

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { resolveConfig, type BridgeConfig } from './config.ts';
import { listenBridge } from './listen.ts';
import { registerTools, type ToolDeps } from './tools.ts';

const SERVER_INFO = { name: 'taskferry-mcp', version: '0.1.0' } as const;
const INSTRUCTIONS = `TaskFerry queues background coding tasks on a host daemon. A dispatch returns an id immediately and does not wait for work.
Typical flow: call taskferry_list to see recent ids, taskferry_dispatch to queue work, then poll taskferry_status until the task reports done, crashed or cancelled, and finally call taskferry_result.
taskferry_list without a directory covers every allowed workspace; pass directory to narrow it. taskferry_status and taskferry_result only see tasks whose directory is on the bridge workspace allowlist. taskferry_dispatch requires an allowlisted directory and model.
Call taskferry_models to see allowed model ids; pass query to search the full installed OpenCode catalog. It reports missingAllowedModels when an allowlisted id is not installed.
taskferry_result accepts fields to select result fields and full to return the complete narration. taskferry_summary queues a bounded summary task: poll taskferry_status and read taskferry_result on the returned summaryTask id. mode activity reads cached activity without spawning a worker.
taskferry_dispatch accepts variant to set the model reasoning level; omit it for the TaskFerry default.
roBind is optional: it exposes host files or directories read-only inside the task sandbox, and each requested path must already be on the bridge read-only bind allowlist. Use it for credentials or shared config, never for broad filesystem access.
Dispatch has no idempotency key, so do not retry an ambiguous dispatch automatically.`;
const MAX_REQUEST_BYTES = 1024 * 1024;
const BEARER = 'Bearer ';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostnameOf(host: string | undefined) {
  if (host === undefined) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

// On a loopback TCP listener, a foreign Host header can be a DNS-rebinding attempt, and any
// browser Origin is a cross-site request. A unix socket has no such exposure: the file mode is
// the boundary, so these checks are for TCP only.
function loopbackRequest(req: http.IncomingMessage) {
  const host = hostnameOf(req.headers.host);
  if (host === undefined || !LOOPBACK_HOSTNAMES.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// The status to refuse with before the MCP layer sees the request, if any. The token is checked
// before anything the caller controls beyond the path, so an unauthenticated request learns
// nothing about Host or Origin handling.
function refusal(req: http.IncomingMessage, config: BridgeConfig) {
  if (req.url !== '/mcp') return 404;
  const authorization = req.headers.authorization ?? '';
  if (
    !authorization.startsWith(BEARER) ||
    !sameSecret(authorization.slice(BEARER.length), config.token)
  ) {
    return 401;
  }
  if (req.method !== 'POST') return 405;
  if (!(req.headers['content-type'] ?? '').includes('application/json')) return 415;
  if (config.listen.kind === 'tcp' && !loopbackRequest(req)) return 403;
  return undefined;
}

function refuse(res: http.ServerResponse, status: number) {
  res.writeHead(status, status === 405 ? { Allow: 'POST' } : undefined).end();
}

// One MCP server and transport per request. The transport is stateless (no session ID), and JSON
// responses keep the bridge a plain request/response endpoint rather than an event stream.
async function serveMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
  deps: Partial<ToolDeps>,
) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  });
  registerTools(
    server,
    {
      daemonSocket: config.daemonSocket,
      allowDirectories: config.allowDirectories,
      allowModels: config.allowModels,
      allowRoBinds: config.allowRoBinds,
    },
    deps,
  );
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await server.close().catch(() => {});
  }
}

export function createBridge(config: BridgeConfig, deps: Partial<ToolDeps> = {}) {
  if (!config.token) throw new Error('bearer token required');
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = refusal(req, config);
    if (status !== undefined) {
      refuse(res, status);
      return;
    }
    serveMcp(req, res, config, deps).catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
}

if (process.argv[1]?.endsWith('/server.ts')) {
  try {
    const config = resolveConfig({ argv: process.argv.slice(2), env: process.env });
    const listener = await listenBridge(createBridge(config), config.listen);
    const where =
      config.listen.kind === 'unix'
        ? `unix socket ${config.listen.path}`
        : `127.0.0.1:${config.listen.port}`;
    console.log(`TaskFerry MCP listening on ${where}`);
    const shutdown = () => {
      void listener.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

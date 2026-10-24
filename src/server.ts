import http from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { resolveConfig, type BridgeConfig } from './config.ts';
import { listenBridge, type Listener } from './listen.ts';
import { registerChangesetTools } from './tools-changeset.ts';
import { registerMessageTool } from './tools-message.ts';
import { registerResumeTool } from './tools-resume.ts';
import { registerTools, type ToolDeps } from './tools.ts';
import { registerWorktreeTool } from './tools-worktree.ts';
import { buildToolScope } from './tools-shared.ts';
import { MAX_REQUEST_BYTES, refuse, transportRefusal } from './transport.ts';

const SERVER_INFO = { name: 'taskferry-mcp', version: '0.1.0' } as const;
const INSTRUCTIONS = `TaskFerry queues background coding tasks on a host daemon. A dispatch returns an id immediately and does not wait for work.
Typical flow: call taskferry_list to see recent ids, taskferry_dispatch to queue work, then poll taskferry_status until the task reports done, crashed or cancelled, and finally call taskferry_result.
taskferry_list without a directory covers every allowed workspace; pass directory to narrow it. taskferry_status and taskferry_result only see tasks whose directory is on the bridge workspace allowlist. taskferry_dispatch requires an allowlisted directory and model.
Call taskferry_models to see allowed model ids; pass query to search the full installed OpenCode catalog. It reports missingAllowedModels when an allowlisted id is not installed.
taskferry_result accepts fields to select result fields and full to return the complete narration. taskferry_summary queues a bounded summary task: poll taskferry_status and read taskferry_result on the returned summaryTask id. mode activity reads cached activity without spawning a worker.
taskferry_message reads a task final message without truncation: without confirm it returns only the length and a short preview; call again with confirm: true, using offset and limit to page a long message.
taskferry_accept applies a pending changeset to its workspace; taskferry_reject refuses and discards it; taskferry_cancel stops a queued or running task. All three are scope-guarded and write-capable.
taskferry_worktree lists or reads files inside a task dispatch directory, read-only, with paths confined to that directory.
taskferry_resume continues a settled task's conversation: pass its taskId and a prompt, and the bridge reuses that task's workspace, model and session. It refuses a queued or running task, or one without a session.
taskferry_dispatch accepts variant to set the model reasoning level; omit it for the TaskFerry default.
roBind is optional: it exposes host files or directories read-only inside the task sandbox, and each requested path must already be on the bridge read-only bind allowlist. Use it for credentials or shared config, never for broad filesystem access.
The server skill profile mounts skills automatically: worker gets the default skills, controller gets every skill root.
Dispatch has no idempotency key, so do not retry an ambiguous dispatch automatically.`;

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
  const scope = buildToolScope(config);
  registerTools(server, scope, deps);
  registerChangesetTools(server, scope);
  registerWorktreeTool(server, scope);
  registerMessageTool(server, scope);
  registerResumeTool(server, scope);
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

function normalizeGatewayAccept(req: http.IncomingMessage): void {
  const value = 'application/json, text/event-stream';
  req.headers.accept = value;
  let found = false;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'accept') {
      req.rawHeaders[i + 1] = value;
      found = true;
    }
  }
  if (!found) req.rawHeaders.push('accept', value);
}

function createSurface(
  config: BridgeConfig,
  token: string,
  loopback: boolean,
  deps: Partial<ToolDeps>,
  normalizeAccept = false,
) {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // The standalone gateway always sent the MCP dual Accept value upstream, so clients
    // that sent `Accept: */*` or no Accept kept working. Preserve that on the joined
    // gateway surface only; the bridge keeps its strict MCP content negotiation.
    if (normalizeAccept) normalizeGatewayAccept(req);
    const status = transportRefusal(req, {
      token,
      loopback,
    });
    if (status !== undefined) {
      refuse(res, status);
      return;
    }
    serveMcp(req, res, config, deps).catch((error: unknown) => {
      console.error('MCP request failed', error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
}

export function createBridge(config: BridgeConfig, deps: Partial<ToolDeps> = {}) {
  if (!config.token) throw new Error('bearer token required');
  return createSurface(config, config.token, config.listen.kind === 'tcp', deps);
}

// The gateway is a second authenticated MCP surface in the same process. It accepts its own
// bearer token, always listens on loopback TCP, and serves the same tools.
export function createGateway(config: BridgeConfig, deps: Partial<ToolDeps> = {}) {
  if (!config.gateway) throw new Error('gateway token required');
  if (config.gateway.token.trim() === '') throw new Error('gateway token must not be empty');
  if (config.gateway.token === config.token) {
    throw new Error('gateway token must differ from the bridge token');
  }
  return createSurface(config, config.gateway.token, true, deps, true);
}

export type Surfaces = {
  bridge: http.Server;
  gateway?: http.Server;
  close: () => Promise<void>;
};

// Both surfaces start together or not at all: a gateway that cannot bind closes the bridge
// listener it was already handed, so a failed start never leaves half the executable up.
export async function startSurfaces(
  config: BridgeConfig,
  deps: Partial<ToolDeps> = {},
): Promise<Surfaces> {
  const bridge = createBridge(config, deps);
  const bridgeListener = await listenBridge(bridge, config.listen);
  try {
    if (!config.gateway) {
      return { bridge, close: bridgeListener.close };
    }
    const gateway = createGateway(config, deps);
    let gatewayListener: Listener;
    try {
      gatewayListener = await listenBridge(gateway, {
        kind: 'tcp',
        port: config.gateway.port,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `gateway surface failed to bind on 127.0.0.1:${config.gateway.port}: ${detail}`,
        { cause: error },
      );
    }
    return {
      bridge,
      gateway,
      close: () =>
        Promise.all([bridgeListener.close(), gatewayListener.close()]).then(() => undefined),
    };
  } catch (error) {
    await bridgeListener.close();
    throw error;
  }
}

if (process.argv[1]?.endsWith('/server.ts')) {
  try {
    const config = resolveConfig({ argv: process.argv.slice(2), env: process.env });
    const surfaces = await startSurfaces(config);
    const where =
      config.listen.kind === 'unix'
        ? `unix socket ${config.listen.path}`
        : `127.0.0.1:${config.listen.port}`;
    console.log(`TaskFerry MCP listening on ${where}`);
    if (config.gateway) {
      console.log(`TaskFerry MCP gateway listening on 127.0.0.1:${config.gateway.port}`);
    }
    const shutdown = () => {
      void surfaces.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

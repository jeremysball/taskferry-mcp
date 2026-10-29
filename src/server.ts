import http from 'node:http';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpHandler,
  isLegacyRequest,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import { resolveConfig, type BridgeConfig } from './config.ts';
import { registerEventMethods } from './event-methods.ts';
import { EventService } from './mcp-events.ts';
import { listenBridge, type Listener } from './listen.ts';
import { registerChangesetTools } from './tools-changeset.ts';
import { registerMessageTool } from './tools-message.ts';
import { registerResumeTool } from './tools-resume.ts';
import { registerTools, type ToolDeps } from './tools.ts';
import { registerWorktreeTool } from './tools-worktree.ts';
import { buildToolScope } from './tools-shared.ts';
import { MAX_REQUEST_BYTES, refuse, transportRefusal } from './transport.ts';

const SERVER_INFO = { name: 'taskferry-mcp', version: '0.1.0' } as const;
const EVENTS_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [...new Set([...SUPPORTED_PROTOCOL_VERSIONS, EVENTS_PROTOCOL_VERSION])];
const CAPABILITIES = {
  tools: { listChanged: false },
  // `events` is the MCP Events extension key read from server/discover. The SDK's capability
  // schema does not know it, but discover advertises the stored object verbatim.
  events: {},
} as unknown as ServerCapabilities;
const INSTRUCTIONS = `TaskFerry queues background coding tasks on a host daemon. A dispatch returns an id immediately and does not wait for work.
Typical flow: call taskferry_list to see recent ids, taskferry_dispatch to queue work, then poll taskferry_status until the task reports done, crashed or cancelled, and finally call taskferry_result.
taskferry_list without a directory covers every allowed workspace; pass directory to narrow it. taskferry_status and taskferry_result only see tasks whose directory is on the bridge workspace allowlist. taskferry_dispatch requires an allowlisted directory and model; executor selects opencode, pi or kilo, and omitting it uses the daemon configured default.
Call taskferry_models to see allowed model ids; pass query to search the full installed OpenCode catalog. It reports missingAllowedModels when an allowlisted id is not installed.
taskferry_result accepts fields to select result fields and full to return the complete narration. taskferry_summary queues a bounded summary task: poll taskferry_status and read taskferry_result on the returned summaryTask id. mode activity returns the activity snapshot and may synchronously launch and wait for a summarizer child, so it can take tens of seconds.
taskferry_message reads a task final message without truncation: without confirm it returns only the length and a short preview; call again with confirm: true, using offset and limit to page a long message.
taskferry_accept applies a pending changeset to its workspace; taskferry_reject refuses and discards it; taskferry_cancel stops a queued or running task. All three are scope-guarded and write-capable.
taskferry_worktree lists or reads files inside a task dispatch directory, read-only, with paths confined to that directory.
taskferry_resume continues a settled task's conversation: pass its taskId and a prompt, and the bridge reuses that task's workspace, model, session and executor. It refuses a queued or running task, or one without a session.
taskferry_dispatch accepts variant to set the model reasoning level; omit it for the TaskFerry default.
roBind is optional: it exposes host files or directories read-only inside the task sandbox, and each requested path must already be on the bridge read-only bind allowlist. Use it for credentials or shared config, never for broad filesystem access.
The server skill profile mounts skills automatically: worker gets the default skills, controller gets every skill root.
Dispatch has no idempotency key, so do not retry an ambiguous dispatch automatically.`;

type SurfaceContext = {
  config: BridgeConfig;
  deps: Partial<ToolDeps>;
  events: EventService;
  principal: string;
};

// One MCP server and transport per request. The handler serves modern 2026-07-28 requests
// (including server/discover) and falls back to stateless 2025-era serving, so both eras share
// the same tools and events surface without sessions or a standalone event stream.
function createServer(context: SurfaceContext) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: CAPABILITIES,
    instructions: INSTRUCTIONS,
    supportedProtocolVersions: SUPPORTED_VERSIONS,
  });
  const scope = buildToolScope(context.config);
  registerTools(server, scope, context.deps);
  registerChangesetTools(server, scope);
  registerWorktreeTool(server, scope);
  registerMessageTool(server, scope);
  registerResumeTool(server, scope);
  registerEventMethods(server, context.events, context.principal, scope);
  return server;
}

// 2025-era requests keep the original stateless streamable-HTTP path: one server and transport per
// request, JSON responses only, no session ID. `parsedBody` is supplied because the era probe has
// already consumed the request stream.
async function serveLegacy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: SurfaceContext,
  parsedBody: unknown,
) {
  const server = createServer(context);
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
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

function sendParseError(res: http.ServerResponse) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    }),
  );
}

function createSurface(
  context: SurfaceContext,
  token: string,
  loopback: boolean,
  normalizeAccept = false,
) {
  // Modern 2026-07-28 requests go through the SDK entry so server/discover and the modern
  // envelope checks behave as specified. Legacy 2025 traffic keeps the bridge's original
  // per-request streamable path below.
  const modern = createMcpHandler(() => createServer(context), {
    legacy: 'reject',
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  const modernNode = toNodeHandler(modern, { maxRequestBodySize: MAX_REQUEST_BYTES });

  const dispatch = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let probe: Request;
    try {
      probe = await toWebRequest(req, undefined, { maxRequestBodySize: MAX_REQUEST_BYTES });
    } catch (error) {
      if ((error as { status?: number }).status === 413) {
        res.writeHead(413).end();
        return;
      }
      throw error;
    }
    const raw = await probe.clone().text();
    let parsedBody: unknown;
    try {
      parsedBody = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      sendParseError(res);
      return;
    }
    if (await isLegacyRequest(probe)) await serveLegacy(req, res, context, parsedBody);
    else await modernNode(req, res, parsedBody);
  };

  const surface = http.createServer((req, res) => {
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
    dispatch(req, res).catch((error: unknown) => {
      console.error('MCP request failed', error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
  surface.on('close', () => {
    void modern.close();
  });
  return surface;
}

export function createBridge(
  config: BridgeConfig,
  deps: Partial<ToolDeps> = {},
  events = new EventService(config),
) {
  if (!config.token) throw new Error('bearer token required');
  return createSurface(
    { config, deps, events, principal: 'bridge' },
    config.token,
    config.listen.kind === 'tcp',
  );
}

// The gateway is a second authenticated MCP surface in the same process. It accepts its own
// bearer token, always listens on loopback TCP, and serves the same tools and events.
export function createGateway(
  config: BridgeConfig,
  deps: Partial<ToolDeps> = {},
  events = new EventService(config),
) {
  if (!config.gateway) throw new Error('gateway token required');
  if (config.gateway.token.trim() === '') throw new Error('gateway token must not be empty');
  if (config.gateway.token === config.token) {
    throw new Error('gateway token must differ from the bridge token');
  }
  return createSurface(
    { config, deps, events, principal: 'gateway' },
    config.gateway.token,
    true,
    true,
  );
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
  events = new EventService(config),
): Promise<Surfaces> {
  const bridge = createBridge(config, deps, events);
  const bridgeListener = await listenBridge(bridge, config.listen);
  try {
    if (!config.gateway) {
      events.start();
      return {
        bridge,
        close: () => {
          events.close();
          return bridgeListener.close();
        },
      };
    }
    const gateway = createGateway(config, deps, events);
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
    events.start();
    return {
      bridge,
      gateway,
      close: () => {
        events.close();
        return Promise.all([bridgeListener.close(), gatewayListener.close()]).then(() => undefined);
      },
    };
  } catch (error) {
    events.close();
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

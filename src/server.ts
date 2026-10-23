import http from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { resolveConfig, type BridgeConfig } from './config.ts';
import { listenBridge } from './listen.ts';
import { registerChangesetTools } from './tools-changeset.ts';
import { registerMessageTool } from './tools-message.ts';
import { registerResumeTool } from './tools-resume.ts';
import { registerTools, type ToolDeps } from './tools.ts';
import { registerWorktreeTool } from './tools-worktree.ts';
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
  const { buildToolScope } = await import('./tools-shared.ts');
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

export function createBridge(config: BridgeConfig, deps: Partial<ToolDeps> = {}) {
  if (!config.token) throw new Error('bearer token required');
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = transportRefusal(req, {
      token: config.token,
      loopback: config.listen.kind === 'tcp',
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

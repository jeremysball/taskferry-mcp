import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DaemonError, callDaemon, type Json } from './daemon.ts';
import { inAllowedRoot } from './scope.ts';

export type ToolScope = {
  daemonSocket: string;
  allowDirectories: readonly string[];
  allowModels: readonly string[];
};

const TASK_STATUS = 'task.status';
const UNKNOWN_TASK = 'UNKNOWN_TASK';
const NOT_ACCESSIBLE = 'task not accessible';
const ALLOWLIST_REQUIRED = 'workspace allowlist required';

// Every schema is strict (`additionalProperties: false`), and a required string must hold
// something other than whitespace. The pattern keeps the value as sent, unlike `.trim()`.
const nonBlank = z.string().regex(/\S/, 'must not be blank');
const taskArgs = z.strictObject({ taskId: nonBlank });

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

// Reads the task's status and refuses unless its directory is inside an allowed root.
async function inScopeStatus(taskId: string, scope: ToolScope) {
  if (!scope.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  let current: unknown;
  try {
    current = await callDaemon(scope.daemonSocket, TASK_STATUS, { taskId });
  } catch (e) {
    // The daemon's own "unknown task id" would tell a caller which IDs exist.
    if (e instanceof DaemonError && e.code === UNKNOWN_TASK)
      throw new Error(NOT_ACCESSIBLE, { cause: e });
    throw e;
  }
  const directory = (current as Json | null)?.directory;
  if (typeof directory !== 'string' || !inAllowedRoot(scope.allowDirectories, directory)) {
    throw new Error(NOT_ACCESSIBLE);
  }
  return current;
}

// Registers the five TaskFerry tools on `server`. Nothing else is reachable: a tool name is the
// only way to a daemon method, and each handler fixes which method it sends.
export function registerTools(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_health',
    {
      description: 'Check daemon connectivity',
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    async () => asText(await callDaemon(scope.daemonSocket, 'system.health', {})),
  );

  server.registerTool(
    'taskferry_list',
    {
      description: 'List tasks in the configured workspace',
      inputSchema: z.strictObject({ directory: nonBlank.optional() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!scope.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
      const directory = args.directory ?? scope.allowDirectories[0];
      if (directory === undefined || !scope.allowDirectories.includes(directory)) {
        throw new Error('directory denied');
      }
      return asText(await callDaemon(scope.daemonSocket, 'task.list', { directory }));
    },
  );

  server.registerTool(
    'taskferry_status',
    { description: 'Check task status', inputSchema: taskArgs, annotations: READ_ONLY },
    async ({ taskId }) => asText(await inScopeStatus(taskId, scope)),
  );

  server.registerTool(
    'taskferry_result',
    { description: 'Read task result', inputSchema: taskArgs, annotations: READ_ONLY },
    async ({ taskId }) => {
      await inScopeStatus(taskId, scope);
      return asText(await callDaemon(scope.daemonSocket, 'task.result', { taskId }));
    },
  );

  server.registerTool(
    'taskferry_dispatch',
    {
      description: 'Dispatch an allowed worker',
      inputSchema: z.strictObject({ directory: nonBlank, model: nonBlank, prompt: nonBlank }),
      annotations: WRITES,
    },
    async (args) => {
      if (!scope.allowDirectories.length || !scope.allowModels.length) {
        throw new Error('dispatch disabled until allowlists configured');
      }
      let real: string;
      try {
        real = realpathSync(args.directory);
      } catch {
        throw new Error('directory unavailable');
      }
      if (!inAllowedRoot(scope.allowDirectories, real) || !scope.allowModels.includes(args.model)) {
        throw new Error('directory or model denied');
      }
      return asText(
        await callDaemon(scope.daemonSocket, 'task.dispatch', {
          directory: real,
          model: args.model,
          prompt: args.prompt,
        }),
      );
    },
  );
}

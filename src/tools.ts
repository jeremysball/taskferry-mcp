import { realpathSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DaemonError, callDaemon, type Json } from './daemon.ts';
import { inAllowedRoot } from './scope.ts';

export type ToolScope = {
  daemonSocket: string;
  allowDirectories: readonly string[];
  allowModels: readonly string[];
  allowRoBinds: readonly string[];
};

const TASK_STATUS = 'task.status';
const UNKNOWN_TASK = 'UNKNOWN_TASK';
const NOT_ACCESSIBLE = 'task not accessible';
const ALLOWLIST_REQUIRED = 'workspace allowlist required';

// Every schema is strict (`additionalProperties: false`), and a required string must hold
// something other than whitespace. The pattern keeps the value as sent, unlike `.trim()`.
const nonBlank = z.string().regex(/\S/, 'must not be blank');
const taskArgs = z.strictObject({ taskId: nonBlank });
const roBinds = z.array(nonBlank).max(32).optional();

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

// Resolve each requested read-only bind against the bridge allowlist. Resolving symlinks before
// the check keeps a link from smuggling in a target the allowlist never named.
function resolveRoBinds(requested: readonly string[] | undefined, scope: ToolScope) {
  if (requested === undefined || requested.length === 0) return [];
  if (!scope.allowRoBinds.length) {
    throw new Error('read-only bind disabled until allowlist configured');
  }
  const resolved = new Set<string>();
  for (const requestedPath of requested) {
    if (!path.isAbsolute(requestedPath)) throw new Error('bind path must be absolute');
    let real: string;
    try {
      real = realpathSync(requestedPath);
    } catch {
      throw new Error('bind path unavailable');
    }
    if (!inAllowedRoot(scope.allowRoBinds, real)) throw new Error('read-only bind denied');
    resolved.add(real);
  }
  return [...resolved];
}

type DispatchArgs = {
  directory: string;
  model: string;
  prompt: string;
  roBind?: readonly string[];
};

async function dispatchTask(args: DispatchArgs, scope: ToolScope) {
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
  const readOnlyBinds = resolveRoBinds(args.roBind, scope);
  return callDaemon(scope.daemonSocket, 'task.dispatch', {
    directory: real,
    model: args.model,
    prompt: args.prompt,
    ...(readOnlyBinds.length ? { roBind: readOnlyBinds } : {}),
  });
}

// Registers the five TaskFerry tools on `server`. Nothing else is reachable: a tool name is the
// only way to a daemon method, and each handler fixes which method it sends.
export function registerTools(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_health',
    {
      description:
        'Check that the TaskFerry daemon is reachable. Returns its pid and protocol version.',
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    async () => asText(await callDaemon(scope.daemonSocket, 'system.health', {})),
  );

  server.registerTool(
    'taskferry_list',
    {
      description:
        "List tasks in an allowed workspace, newest first. Each row carries the task's id, status, model, executor and timestamps; use the id with taskferry_status or taskferry_result.",
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
    {
      description:
        'Read one task state and metadata. Poll this after taskferry_dispatch; a queued task has not started yet.',
      inputSchema: taskArgs,
      annotations: READ_ONLY,
    },
    async ({ taskId }) => asText(await inScopeStatus(taskId, scope)),
  );

  server.registerTool(
    'taskferry_result',
    {
      description:
        'Read a settled task final message and result metadata. This first reads task status to enforce the workspace allowlist.',
      inputSchema: taskArgs,
      annotations: READ_ONLY,
    },
    async ({ taskId }) => {
      await inScopeStatus(taskId, scope);
      return asText(await callDaemon(scope.daemonSocket, 'task.result', { taskId }));
    },
  );

  server.registerTool(
    'taskferry_dispatch',
    {
      description:
        'Queue a background task and return its id immediately. Poll taskferry_status until it settles, then read taskferry_result. directory must be an allowed workspace and model an allowed model. roBind optionally exposes host paths read-only inside the task sandbox; every path must be on the bridge read-only bind allowlist.',
      inputSchema: z.strictObject({
        directory: nonBlank,
        model: nonBlank,
        prompt: nonBlank,
        roBind: roBinds,
      }),
      annotations: WRITES,
    },
    async (args) => asText(await dispatchTask(args, scope)),
  );
}

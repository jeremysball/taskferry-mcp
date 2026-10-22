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
const LIST_ROW_CAP = 500;

const RESULT_FIELDS = [
  'message',
  'narration',
  'tokens',
  'cost',
  'sessionId',
  'exitCode',
  'signal',
  'spawnError',
  'failureReason',
  'failureDetail',
  'logPath',
  'outputDir',
  'incomplete',
  'finalMarker',
  'finalStatus',
  'class',
  'diff',
  'diffStat',
  'changesetError',
  'checkStatus',
  'checkCommand',
  'checkExitCode',
  'checkOutputTail',
  'checkStartedAt',
  'checkEndedAt',
  'checkOverride',
  'parentTaskId',
  'projectConfigWarning',
  'prompt',
  'promptAugmented',
] as const;
const STATUSES = ['queued', 'running', 'done', 'crashed', 'cancelled', 'unknown'] as const;

// Every schema is strict (`additionalProperties: false`), and a required string must hold
// something other than whitespace. The pattern keeps the value as sent, unlike `.trim()`.
const nonBlank = z.string().regex(/\S/, 'must not be blank');
const taskArgs = z.strictObject({ taskId: nonBlank });
const roBinds = z.array(nonBlank).max(32).optional();
const resultArgs = z.strictObject({
  taskId: nonBlank,
  full: z.boolean().optional(),
  fields: z.array(z.enum(RESULT_FIELDS)).min(1).optional(),
});
const summaryArgs = z.strictObject({
  taskId: nonBlank,
  mode: z.enum(['report', 'activity']).optional(),
  maxWords: z.number().int().min(75).max(300).optional(),
});

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

function isVisibleRow(row: unknown, roots: readonly string[]): row is Json {
  if (typeof row !== 'object' || row === null) return false;
  const directory = (row as Json).directory;
  return typeof directory === 'string' && inAllowedRoot(roots, directory);
}

function countStatuses(rows: readonly Json[]) {
  const counts: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) {
    const status = row.status;
    if (typeof status === 'string' && status in counts) counts[status] += 1;
  }
  return counts;
}

// Lists without a directory return every task the daemon still holds, capped at its newest 500
// rows. Filter those rows through the same allowlist the direct lookup uses, so the all-workspace
// view cannot expose a workspace the bridge was not configured for.
function visibleList(result: unknown, roots: readonly string[]) {
  const tasks = (result as Json | null)?.tasks;
  if (!Array.isArray(tasks)) return result;
  const rows = tasks.filter((row): row is Json => isVisibleRow(row, roots));
  return {
    counts: countStatuses(rows),
    tasks: rows,
    ...(tasks.length >= LIST_ROW_CAP
      ? { note: 'daemon row cap reached; older tasks may be omitted' }
      : {}),
  };
}

async function listTasks(args: { directory?: string }, scope: ToolScope) {
  if (!scope.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  if (args.directory === undefined) {
    return visibleList(
      await callDaemon(scope.daemonSocket, 'task.list', {}),
      scope.allowDirectories,
    );
  }
  let real: string;
  try {
    real = realpathSync(args.directory);
  } catch {
    throw new Error('directory unavailable');
  }
  if (!inAllowedRoot(scope.allowDirectories, real)) throw new Error('directory denied');
  return callDaemon(scope.daemonSocket, 'task.list', { directory: real });
}

type ResultArgs = { taskId: string; full?: boolean; fields?: readonly string[] };

async function readResult(args: ResultArgs, scope: ToolScope) {
  await inScopeStatus(args.taskId, scope);
  return callDaemon(scope.daemonSocket, 'task.result', {
    taskId: args.taskId,
    ...(args.full === undefined ? {} : { full: args.full }),
    ...(args.fields === undefined ? {} : { fields: args.fields }),
  });
}

type SummaryArgs = { taskId: string; mode?: 'report' | 'activity'; maxWords?: number };

async function summarize(args: SummaryArgs, scope: ToolScope) {
  await inScopeStatus(args.taskId, scope);
  return callDaemon(scope.daemonSocket, 'task.summary', {
    taskId: args.taskId,
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    ...(args.maxWords === undefined ? {} : { maxWords: args.maxWords }),
  });
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

// Registers the six TaskFerry tools on `server`. Nothing else is reachable: a tool name is the
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
        'List recent tasks across all allowed workspaces, newest first, capped at 500 rows. Pass directory to scope the list to one allowed workspace. Each row carries id, status, model, startedAt, directory and failureReason; use taskferry_status for full lifecycle and log fields.',
      inputSchema: z.strictObject({ directory: nonBlank.optional() }),
      annotations: READ_ONLY,
    },
    async (args) => asText(await listTasks(args, scope)),
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
        'Read a settled task final message and result metadata. fields selects specific result fields; full returns the complete narration and requires narration in fields. This first reads task status to enforce the workspace allowlist.',
      inputSchema: resultArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await readResult(args, scope)),
  );

  server.registerTool(
    'taskferry_summary',
    {
      description:
        'Create a bounded summary task for a task. Returns a queued summary task id in summaryTask; poll taskferry_status then taskferry_result on that id. mode activity reads cached activity without spawning; report (default) queues a summarizer.',
      inputSchema: summaryArgs,
      annotations: WRITES,
    },
    async (args) => asText(await summarize(args, scope)),
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

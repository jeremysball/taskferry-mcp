import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon, type Json } from './daemon.ts';
import { listOpencodeModels } from './models.ts';
import { inAllowedRoot } from './scope.ts';
import {
  ALLOWLIST_REQUIRED,
  READ_ONLY,
  WRITES,
  asText,
  assertAllowedModel,
  inScopeStatus,
  nonBlank,
  resolveRoBinds,
  type ToolDeps,
  type ToolScope,
} from './tools-shared.ts';

export type { ToolDeps, ToolScope } from './tools-shared.ts';

const LIST_ROW_CAP = 500;
const MODEL_ROW_CAP = 50;

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
const modelArgs = z.strictObject({
  query: nonBlank.max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

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

type ModelArgs = { query?: string; limit?: number };

async function catalogModels(args: ModelArgs, scope: ToolScope, load: ToolDeps['listModels']) {
  const installed = await load();
  const installedSet = new Set(installed);
  const missingAllowedModels = scope.allowModels.filter((model) => !installedSet.has(model));
  const query = args.query?.toLowerCase();
  const candidates = query
    ? installed
    : scope.allowModels.filter((model) => installedSet.has(model));
  const matches = candidates.filter(
    (model) => query === undefined || model.toLowerCase().includes(query),
  );
  const limit = args.limit ?? MODEL_ROW_CAP;
  const notes: string[] = [];
  if (scope.allowModels.length === 0) notes.push('model allowlist is empty; dispatch is disabled');
  if (matches.length > limit) notes.push(`showing first ${limit} of ${matches.length} matches`);
  return {
    allowedModels: [...scope.allowModels],
    missingAllowedModels,
    totalInstalledModels: installed.length,
    query: args.query ?? null,
    matched: matches.length,
    models: matches.slice(0, limit).map((id) => ({
      id,
      allowed: scope.allowModels.includes(id),
    })),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
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

type DispatchArgs = {
  directory: string;
  model: string;
  prompt: string;
  variant?: string;
  roBind?: readonly string[];
};

function resolveDispatchDirectory(directory: string, scope: ToolScope) {
  if (!scope.allowDirectories.length) {
    throw new Error('dispatch disabled: workspace allowlist is empty');
  }
  let real: string;
  try {
    real = realpathSync(directory);
  } catch {
    throw new Error(`workspace unavailable: ${directory}`);
  }
  if (!inAllowedRoot(scope.allowDirectories, real)) {
    throw new Error(
      `workspace denied: ${real} is outside allowed roots (${scope.allowDirectories.join(', ')})`,
    );
  }
  return real;
}

async function dispatchTask(args: DispatchArgs, scope: ToolScope) {
  const real = resolveDispatchDirectory(args.directory, scope);
  assertAllowedModel(args.model, scope);
  const readOnlyBinds = resolveRoBinds(args.roBind, scope);
  return callDaemon(scope.daemonSocket, 'task.dispatch', {
    directory: real,
    model: args.model,
    prompt: args.prompt,
    ...(args.variant === undefined ? {} : { variant: args.variant }),
    ...(readOnlyBinds.length ? { roBind: readOnlyBinds } : {}),
  });
}

// Registers the seven TaskFerry tools on `server`. Nothing else is reachable: a tool name is the
// only way to a daemon method, and each handler fixes which method it sends. `taskferry_models`
// is the one handler that runs a local command instead of a daemon method.
export function registerTools(server: McpServer, scope: ToolScope, deps: Partial<ToolDeps> = {}) {
  const listModels = deps.listModels ?? listOpencodeModels;
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
    'taskferry_models',
    {
      description:
        'List OpenCode model ids and mark which ones the bridge allows. With no query, returns allowed models only. With query, searches the full installed catalog. missingAllowedModels names allowlisted ids that are not installed.',
      inputSchema: modelArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await catalogModels(args, scope, listModels)),
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
        'Queue a background task and return its id immediately. Poll taskferry_status until it settles, then read taskferry_result. directory must be an allowed workspace and model an allowed model; call taskferry_models to see allowed ids. variant sets the model reasoning level, for example low, high, xhigh, max, highest, or a model-specific name; omit it for the TaskFerry default. roBind optionally exposes host paths read-only inside the task sandbox; every path must be on the bridge read-only bind allowlist.',
      inputSchema: z.strictObject({
        directory: nonBlank,
        model: nonBlank,
        prompt: nonBlank,
        variant: nonBlank.max(64).optional(),
        roBind: roBinds,
      }),
      annotations: WRITES,
    },
    async (args) => asText(await dispatchTask(args, scope)),
  );
}

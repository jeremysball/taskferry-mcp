import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon, type Json } from './daemon.ts';
import { listOpencodeModels } from './models.ts';
import { inResolvedRoot, resolveRoots } from './scope.ts';
import {
  ALLOWLIST_REQUIRED,
  DESTRUCTIVE,
  READ_ONLY,
  WRITES,
  asText,
  assertAllowedModel,
  assertAllowedDirectory,
  buildDispatchRequest,
  EXECUTORS,
  inScopeStatus,
  nonBlank,
  readTaskResult,
  type Executor,
  type ToolDeps,
  type ToolScope,
} from './tools-shared.ts';

export type { ToolDeps, ToolScope } from './tools-shared.ts';

const LIST_ROW_CAP = 500;
const MODEL_ROW_CAP = 50;
const EMPTY_TASK_LIST_SENTINELS = new Set([
  'none found in this workspace',
  "none found (this server process's lifetime)",
]);

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
const dispatchInput = z.strictObject({
  directory: nonBlank,
  model: nonBlank,
  prompt: nonBlank,
  variant: nonBlank.max(64).optional(),
  roBind: roBinds,
  executor: z.enum(EXECUTORS).optional(),
  noSandbox: z.boolean().optional(),
});
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

async function isVisibleRow(row: unknown, roots: readonly string[]) {
  if (typeof row !== 'object' || row === null) return false;
  const directory = (row as Json).directory;
  return typeof directory === 'string' && (await inResolvedRoot(roots, directory));
}

function countStatuses(rows: readonly Json[]) {
  const counts: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) {
    const status = row.status;
    if (typeof status === 'string' && status in counts) counts[status] += 1;
  }
  return counts;
}

type TaskList = Json & { tasks: Json[] };

function taskListResult(result: unknown): TaskList {
  if (typeof result === 'object' && result !== null) {
    const value = result as Json;
    if (Array.isArray(value.tasks)) return value as TaskList;
    if (typeof value.tasks === 'string' && EMPTY_TASK_LIST_SENTINELS.has(value.tasks)) {
      return { ...value, tasks: [] };
    }
  }
  throw new Error('invalid task.list reply: tasks must be an array');
}

async function visibleList(results: unknown[], roots: readonly string[]) {
  const rows = new Map<unknown, Json>();
  let capped = false;
  for (const result of results) {
    const { tasks } = taskListResult(result);
    capped ||= tasks.length >= LIST_ROW_CAP;
    for (const row of tasks) {
      if (await isVisibleRow(row, roots)) rows.set((row as Json).id, row as Json);
    }
  }
  const merged = [...rows.values()].sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  );
  capped ||= merged.length > LIST_ROW_CAP;
  const tasks = merged.slice(0, LIST_ROW_CAP);
  return {
    counts: countStatuses(tasks),
    tasks,
    ...(capped ? { note: 'daemon row cap reached; older tasks may be omitted' } : {}),
  };
}

async function listTasks(args: { directory?: string }, scope: ToolScope) {
  if (!scope.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  const roots = await resolveRoots(scope.allowDirectories);
  if (args.directory === undefined) {
    // `task.list {}` is the daemon's existing `--all` mode: one request over
    // the whole recorded history. Filtering those rows through the allowed
    // roots preserves workspace authorization and still covers tasks nested
    // below an allowed root. Do not enumerate roots into directory requests:
    // that fragments history, misses nested tasks the daemon would return,
    // and is not the RPC's all-tasks semantics.
    return visibleList([await callDaemon(scope, 'task.list', {})], roots);
  }
  const real = await assertAllowedDirectory(args.directory, scope, roots);
  return taskListResult(await callDaemon(scope, 'task.list', { directory: real }));
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
  if (args.full === true && !args.fields?.includes('narration')) {
    throw new Error('full requires fields to include narration');
  }
  return (await readTaskResult(args.taskId, args.fields, scope, { full: args.full })).result;
}

type SummaryArgs = { taskId: string; mode?: 'report' | 'activity'; maxWords?: number };

async function summarize(args: SummaryArgs, scope: ToolScope) {
  await inScopeStatus(args.taskId, scope);
  return callDaemon(
    scope,
    'task.summary',
    {
      taskId: args.taskId,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(args.maxWords === undefined ? {} : { maxWords: args.maxWords }),
    },
    scope.limits.summaryTimeoutMs,
  );
}

type DispatchArgs = {
  directory: string;
  model: string;
  prompt: string;
  variant?: string;
  roBind?: readonly string[];
  executor?: Executor;
  noSandbox?: boolean;
};

async function dispatchTask(args: DispatchArgs, scope: ToolScope) {
  const real = await assertAllowedDirectory(args.directory, scope);
  assertAllowedModel(args.model, scope);
  return callDaemon(scope, 'task.dispatch', {
    directory: real,
    model: args.model,
    // Omitted executor is not the same as an explicit "opencode": let the
    // daemon apply its configured default, as every bridge release before
    // this argument existed did.
    ...(args.executor === undefined ? {} : { executor: args.executor }),
    // An explicit false is forwarded as false rather than dropped; noSandbox
    // is per-dispatch and the daemon sandboxes unless it receives true.
    ...(args.noSandbox === undefined ? {} : { noSandbox: args.noSandbox }),
    ...(await buildDispatchRequest(args, scope)),
  });
}

// Registers the seven TaskFerry tools on `server`. Nothing else is reachable: a tool name is the
// only way to a daemon method, and each handler fixes which method it sends. `taskferry_models`
// is the one handler that runs a local command instead of a daemon method.
export function registerTools(server: McpServer, scope: ToolScope, deps: Partial<ToolDeps> = {}) {
  const listModels = deps.listModels ?? (() => listOpencodeModels(scope.limits));
  server.registerTool(
    'taskferry_health',
    {
      description:
        'Check that the TaskFerry daemon is reachable. Returns its pid and protocol version.',
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    async () => asText(await callDaemon(scope, 'system.health', {})),
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
        'Create a bounded summary task for a task. Returns a queued summary task id in summaryTask; poll taskferry_status then taskferry_result on that id. mode report (default) queues a summarizer. mode activity returns the activity snapshot and may synchronously launch and wait for a summarizer child, so it can take tens of seconds.',
      inputSchema: summaryArgs,
      annotations: WRITES,
    },
    async (args) => asText(await summarize(args, scope)),
  );

  server.registerTool(
    'taskferry_dispatch',
    {
      description:
        'Queue a background task and return its id immediately. Poll taskferry_status until it settles, then read taskferry_result. directory must be an allowed workspace and model an allowed model; call taskferry_models to see allowed ids. executor selects the worker CLI: opencode, pi, or kilo; omit it to use the daemon configured default. The model id is passed through unchanged in provider/model form, which is also how Kilo names its models. variant sets the model reasoning level, for example low, high, xhigh, max, highest, or a model-specific name; omit it for the TaskFerry default. roBind optionally exposes host paths read-only inside the task sandbox; every path must be on the bridge read-only bind allowlist. noSandbox is an optional per-dispatch boolean, false by default: true disables the bwrap filesystem sandbox for this task, so it runs directly on the host filesystem, writes land on real host paths, and no copy-on-write overlay or accept/reject gate applies. That removes filesystem isolation and is not the same as noOverlay. false or omitted requests the normal path, but cannot re-enable the sandbox when the daemon has sandboxing disabled globally. The bridge directory, model, and bind allowlists are enforced before forwarding; they gate what may be dispatched and do not limit what the worker can read or write on the host after an unsandboxed launch.',
      inputSchema: dispatchInput,
      annotations: DESTRUCTIVE,
    },
    async (args) => asText(await dispatchTask(args, scope)),
  );
}

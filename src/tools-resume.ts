import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon } from './daemon.ts';
import {
  asText,
  assertAllowedModel,
  assertAllowedDirectory,
  buildDispatchRequest,
  EXECUTORS,
  inScopeStatus,
  isExecutor,
  nonBlank,
  WRITES,
  type Executor,
  type ToolScope,
} from './tools-shared.ts';

const roBinds = z.array(nonBlank).max(32).optional();
const resumeArgs = z.strictObject({
  taskId: nonBlank,
  prompt: nonBlank,
  variant: nonBlank.max(64).optional(),
  roBind: roBinds,
});

type ResumeArgs = {
  taskId: string;
  prompt: string;
  variant?: string;
  roBind?: readonly string[];
};

type ResumeSource = {
  directory: string;
  model: string;
  sessionId: string;
  executor?: Executor;
};

function requiredField(value: unknown, message: string) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

function resolveResumeSource(current: Record<string, unknown>, scope: ToolScope): ResumeSource {
  const status = current.status;
  if (status === 'queued' || status === 'running') {
    throw new Error('task is still running; wait for it to settle before resuming');
  }
  const sessionId = requiredField(current.sessionId, 'task has no resumable session');
  const directory = requiredField(current.directory, 'task has no dispatch directory');
  const model = requiredField(current.model, 'task has no model');
  assertAllowedModel(model, scope);
  // A modern daemon backfills legacy records to "opencode" and omits a null
  // executorId from status; a daemon that predates the field sends neither.
  // Omit it in that case and let the daemon's session lookup or configured
  // default decide, exactly as an older bridge did. A recorded executor is
  // forwarded so a Kilo session never resumes through OpenCode just because
  // that is the daemon default.
  const recorded = current.executorId;
  if (recorded == null) return { directory, model, sessionId };
  if (!isExecutor(recorded)) {
    throw new Error(
      `task has an unsupported executor: ${String(recorded)}; supported executors: ${EXECUTORS.join(', ')}`,
    );
  }
  return { directory, model, sessionId, executor: recorded };
}

// Queue a follow-up into an existing session. The workspace, model and executor come from the
// source task, not from the caller, so a resume can never move a session to a different workspace
// or model than the bridge would have allowed, or to an executor other than the recorded one.
async function resumeTask(args: ResumeArgs, scope: ToolScope) {
  const current = (await inScopeStatus(args.taskId, scope)) as Record<string, unknown>;
  const { directory: sourceDirectory, executor, ...source } = resolveResumeSource(current, scope);
  const directory = await assertAllowedDirectory(sourceDirectory, scope);
  return callDaemon(scope, 'task.dispatch', {
    ...source,
    directory,
    ...(executor === undefined ? {} : { executor }),
    ...(await buildDispatchRequest(args, scope)),
  });
}

export function registerResumeTool(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_resume',
    {
      description:
        "Queue a follow-up prompt into a settled task's existing session. The workspace, model, session and executor are read from the task, not the caller, so a resume cannot change any of them; workspace and model still pass the bridge allowlists, and the executor must be one of opencode, pi, or kilo. A Kilo session resumes on Kilo even when the daemon default is OpenCode. The task must have a session and must not be queued or running. Returns a new task id; poll taskferry_status and read taskferry_result as usual. variant sets the reasoning level for this turn; roBind is optional and follows the same allowlist as dispatch.",
      inputSchema: resumeArgs,
      annotations: WRITES,
    },
    async (args) => asText(await resumeTask(args, scope)),
  );
}

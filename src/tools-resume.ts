import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon } from './daemon.ts';
import {
  asText,
  assertAllowedModel,
  assertAllowedDirectory,
  buildDispatchRequest,
  inScopeStatus,
  nonBlank,
  WRITES,
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

type ResumeSource = { directory: string; model: string; sessionId: string };

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
  return { directory, model, sessionId };
}

// Queue a follow-up into an existing session. The workspace and model come from the source task,
// not from the caller, so a resume can never move a session into a workspace or model the bridge
// would not have allowed directly.
async function resumeTask(args: ResumeArgs, scope: ToolScope) {
  const current = (await inScopeStatus(args.taskId, scope)) as Record<string, unknown>;
  const source = resolveResumeSource(current, scope);
  const directory = await assertAllowedDirectory(source.directory, scope);
  return callDaemon(scope, 'task.dispatch', {
    ...source,
    directory,
    ...(await buildDispatchRequest(args, scope)),
  });
}

export function registerResumeTool(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_resume',
    {
      description:
        "Queue a follow-up prompt into a settled task's existing session. The workspace and model are read from the task and must pass the bridge allowlists, so a resume cannot change either. The task must have a session and must not be queued or running. Returns a new task id; poll taskferry_status and read taskferry_result as usual. variant sets the reasoning level for this turn; roBind is optional and follows the same allowlist as dispatch.",
      inputSchema: resumeArgs,
      annotations: WRITES,
    },
    async (args) => asText(await resumeTask(args, scope)),
  );
}

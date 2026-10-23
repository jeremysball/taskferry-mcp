import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon } from './daemon.ts';
import { DESTRUCTIVE, asText, inScopeStatus, nonBlank, type ToolScope } from './tools-shared.ts';

const taskArgs = z.strictObject({ taskId: nonBlank });
const cancelArgs = z.strictObject({
  taskId: nonBlank,
  graceMs: z.number().int().min(0).max(300_000).optional(),
});

// The daemon's accept/reject/cancel methods, exposed behind the same workspace
// scope guard as the read tools. `force` is deliberately absent: a remote
// caller cannot manually verify a failed check gate, so the bridge leaves the
// override to the CLI on the host.
export function registerChangesetTools(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_accept',
    {
      description:
        'Accept (apply) a settled task pending changeset to its workspace. The task must have a pending changeset and no blocking check gate; a failed or running gate must be fixed forward on the host. This writes the diff to the live workspace.',
      inputSchema: taskArgs,
      annotations: DESTRUCTIVE,
    },
    async ({ taskId }) => {
      await inScopeStatus(taskId, scope);
      return asText(await callDaemon(scope.daemonSocket, 'task.accept', { taskId }));
    },
  );

  server.registerTool(
    'taskferry_reject',
    {
      description:
        'Reject (refuse) a task pending changeset and discard its overlay. The workspace is not modified. The task must have a pending changeset; a settled task with no pending changeset is refused by the daemon.',
      inputSchema: taskArgs,
      annotations: DESTRUCTIVE,
    },
    async ({ taskId }) => {
      await inScopeStatus(taskId, scope);
      return asText(await callDaemon(scope.daemonSocket, 'task.reject', { taskId }));
    },
  );

  server.registerTool(
    'taskferry_cancel',
    {
      description:
        'Cancel a queued or running task. A queued task is removed before launch. A running task receives SIGTERM and is escalated to SIGKILL after graceMs (the daemon default when omitted). A settled task is left unchanged and reports that there was nothing to cancel.',
      inputSchema: cancelArgs,
      annotations: DESTRUCTIVE,
    },
    async ({ taskId, graceMs }) => {
      await inScopeStatus(taskId, scope);
      return asText(
        await callDaemon(scope.daemonSocket, 'task.cancel', {
          taskId,
          ...(graceMs === undefined ? {} : { graceMs }),
        }),
      );
    },
  );
}

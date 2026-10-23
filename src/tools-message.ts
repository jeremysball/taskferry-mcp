import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callDaemon, type Json } from './daemon.ts';
import { READ_ONLY, asText, inScopeStatus, nonBlank, type ToolScope } from './tools-shared.ts';

const PREVIEW_CHARS = 500;
const PAGE_MAX = 100_000;
const OFFSET_MAX = 10_000_000;

const messageArgs = z.strictObject({
  taskId: nonBlank,
  confirm: z.boolean().optional(),
  offset: z.number().int().min(0).max(OFFSET_MAX).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).optional(),
});

type MessageArgs = z.infer<typeof messageArgs>;

async function readMessage(args: MessageArgs, scope: ToolScope) {
  await inScopeStatus(args.taskId, scope);
  // Ask for the message alone so the daemon does not parse or ship narration
  // and diff fields for a read that only needs the final turn.
  const detail = (await callDaemon(scope.daemonSocket, 'task.result', {
    taskId: args.taskId,
    fields: ['message'],
  })) as Json | null;
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const base = {
    taskId: args.taskId,
    status: detail?.status ?? null,
    messageChars: message.length,
  };

  if (args.confirm !== true) {
    return {
      ...base,
      preview: message.slice(0, PREVIEW_CHARS),
      previewTruncated: message.length > PREVIEW_CHARS,
      note: 'full message withheld; call again with confirm: true to read it, and use offset and limit to page a large message',
    };
  }

  const offset = args.offset ?? 0;
  const end = args.limit === undefined ? undefined : offset + args.limit;
  const chunk = message.slice(offset, end);
  const truncated = offset + chunk.length < message.length;
  return {
    ...base,
    offset,
    returnedChars: chunk.length,
    message: chunk,
    truncated,
    ...(truncated ? { nextOffset: offset + chunk.length } : {}),
  };
}

// Reads a task's final message without the daemon's narration preview cap. The
// confirmation gate keeps a caller from pulling an arbitrarily large message
// into its context by accident; paging keeps even a confirmed read inside a
// client's response limit.
export function registerMessageTool(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_message',
    {
      description:
        'Read a task final message without truncation. Without confirm: true the result contains only messageChars and a short preview. With confirm: true it returns the entire message, or one page when offset and limit are set; nextOffset names the next page. This first reads task status to enforce the workspace allowlist.',
      inputSchema: messageArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await readMessage(args, scope)),
  );
}

import { z } from 'zod';
import { DaemonError, callDaemon, type Json } from './daemon.ts';
import { inAllowedRoot } from './scope.ts';

export type ToolScope = {
  daemonSocket: string;
  allowDirectories: readonly string[];
  allowModels: readonly string[];
  allowRoBinds: readonly string[];
};

export type ToolDeps = {
  listModels: () => Promise<string[]>;
};

export const TASK_STATUS = 'task.status';
export const UNKNOWN_TASK = 'UNKNOWN_TASK';
export const NOT_ACCESSIBLE = 'task not accessible';
export const ALLOWLIST_REQUIRED = 'workspace allowlist required';

// Every schema is strict (`additionalProperties: false`), and a required string must hold
// something other than whitespace. The pattern keeps the value as sent, unlike `.trim()`.
export const nonBlank = z.string().regex(/\S/, 'must not be blank');

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

// Reads the task's status and refuses unless its directory is inside an allowed root.
export async function inScopeStatus(taskId: string, scope: ToolScope) {
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

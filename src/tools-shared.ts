import { realpathSync } from 'node:fs';
import path from 'node:path';
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

// Rejects a dispatch when the model allowlist is empty or the model is not on it. Shared by
// dispatch and resume so both name the denied side the same way.
export function assertAllowedModel(model: string, scope: ToolScope) {
  if (!scope.allowModels.length) {
    throw new Error('dispatch disabled: model allowlist is empty');
  }
  if (!scope.allowModels.includes(model)) {
    throw new Error(
      `model denied: ${model} is not allowed; allowed models: ${scope.allowModels.join(', ')}`,
    );
  }
}

// Resolve each requested read-only bind against the bridge allowlist. Resolving symlinks before
// the check keeps a link from smuggling in a target the allowlist never named.
export function resolveRoBinds(requested: readonly string[] | undefined, scope: ToolScope) {
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

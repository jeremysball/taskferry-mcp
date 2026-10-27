import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DaemonError, callDaemon, type Json } from './daemon.ts';
import { inAllowedRoot, inResolvedRoot, resolveRoots } from './scope.ts';
import { DEFAULT_LIMITS, type BridgeConfig, type BridgeLimits } from './config.ts';
import { skillBindPaths, type SkillProfile } from './skills.ts';

export type ToolScope = {
  daemonSocket: string;
  allowDirectories: readonly string[];
  allowModels: readonly string[];
  allowRoBinds: readonly string[];
  skillProfile: SkillProfile;
  skillRoot: string;
  serverRoBinds: readonly string[];
  limits: BridgeLimits;
};

export function buildToolScope(config: BridgeConfig): ToolScope {
  return {
    daemonSocket: config.daemonSocket,
    allowDirectories: config.allowDirectories,
    allowModels: config.allowModels,
    allowRoBinds: config.allowRoBinds,
    skillProfile: config.skillProfile,
    skillRoot: config.skillRoot,
    serverRoBinds: config.serverRoBinds,
    limits: {
      daemonTimeoutMs: config.daemonTimeoutMs ?? DEFAULT_LIMITS.daemonTimeoutMs,
      listTimeoutMs: config.listTimeoutMs ?? DEFAULT_LIMITS.listTimeoutMs,
      modelsCacheTtlMs: config.modelsCacheTtlMs ?? DEFAULT_LIMITS.modelsCacheTtlMs,
      previewChars: config.previewChars ?? DEFAULT_LIMITS.previewChars,
    },
  };
}

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

// The daemon's executor names. Keep this list in step with TaskFerry's
// `KNOWN_EXECUTORS`; the bridge validates before forwarding so an unknown name
// fails at the tool boundary instead of halfway through a dispatch.
export const EXECUTORS = ['opencode', 'pi', 'kilo'] as const;
export type Executor = (typeof EXECUTORS)[number];

export function isExecutor(value: unknown): value is Executor {
  return typeof value === 'string' && (EXECUTORS as readonly string[]).includes(value);
}

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
    current = await callDaemon(scope, TASK_STATUS, { taskId });
  } catch (e) {
    // The daemon's own "unknown task id" would tell a caller which IDs exist.
    if (e instanceof DaemonError && e.code === UNKNOWN_TASK)
      throw new Error(NOT_ACCESSIBLE, { cause: e });
    throw e;
  }
  const directory = (current as Json | null)?.directory;
  if (typeof directory !== 'string' || !(await inAllowedRoot(scope.allowDirectories, directory))) {
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

// Resolve every read-only bind for a dispatch or resume. Server-owned binds (`always`, from the
// skill profile and `serverRoBinds`) are resolved and required to exist, but skip the caller
// allowlist because no tool argument chooses them. Caller bindings still go through that
// allowlist. Resolving symlinks before the check keeps a link from smuggling in a target the
// allowlist never named.
export async function resolveRoBinds(
  requested: readonly string[] | undefined,
  scope: ToolScope,
  always: readonly string[] = [],
) {
  const resolved = new Set<string>();
  for (const bindPath of always) {
    if (!path.isAbsolute(bindPath)) throw new Error(`server bind must be absolute: ${bindPath}`);
    try {
      resolved.add(await realpath(bindPath));
    } catch {
      throw new Error(`server bind unavailable: ${bindPath}`);
    }
  }
  if (requested === undefined || requested.length === 0) return [...resolved];
  if (!scope.allowRoBinds.length) {
    throw new Error('read-only bind disabled until allowlist configured');
  }
  for (const requestedPath of requested) {
    if (!path.isAbsolute(requestedPath)) throw new Error('bind path must be absolute');
    let real: string;
    try {
      real = await realpath(requestedPath);
    } catch {
      throw new Error('bind path unavailable');
    }
    if (!(await inAllowedRoot(scope.allowRoBinds, real))) throw new Error('read-only bind denied');
    resolved.add(real);
  }
  return [...resolved];
}

export async function assertAllowedDirectory(
  dir: string,
  scope: ToolScope,
  roots?: readonly string[],
) {
  if (!scope.allowDirectories.length) throw new Error(ALLOWLIST_REQUIRED);
  let real: string;
  try {
    real = await realpath(dir);
  } catch (error) {
    throw new Error(`workspace unavailable: ${dir}`, { cause: error });
  }
  if (!(await inResolvedRoot(roots ?? (await resolveRoots(scope.allowDirectories)), real))) {
    throw new Error(
      `workspace denied: ${real} is outside allowed roots (${scope.allowDirectories.join(', ')})`,
    );
  }
  return real;
}

export async function readTaskResult(
  taskId: string,
  fields: readonly string[] | undefined,
  scope: ToolScope,
  options: { full?: boolean } = {},
) {
  const current = (await inScopeStatus(taskId, scope)) as Json;
  const result = await callDaemon(scope, 'task.result', {
    taskId,
    ...(fields === undefined ? {} : { fields }),
    ...(options.full === undefined ? {} : { full: options.full }),
  });
  return { status: current.status, result };
}

export async function buildDispatchRequest(
  args: { prompt: string; variant?: string; roBind?: readonly string[] },
  scope: ToolScope,
) {
  const serverBinds = [
    ...skillBindPaths(scope.skillProfile, scope.skillRoot),
    ...scope.serverRoBinds,
  ];
  const readOnlyBinds = await resolveRoBinds(args.roBind, scope, serverBinds);
  return {
    prompt: args.prompt,
    ...(args.variant === undefined ? {} : { variant: args.variant }),
    ...(readOnlyBinds.length ? { roBind: readOnlyBinds } : {}),
  };
}

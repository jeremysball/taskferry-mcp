import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { errorCode } from './errors.ts';
import { isSkillProfile, SKILL_PROFILES, type SkillProfile } from './skills.ts';

export type Listen = { kind: 'unix'; path: string } | { kind: 'tcp'; port: number };

export const DEFAULT_LIMITS = {
  daemonTimeoutMs: 5000,
  listTimeoutMs: 15000,
  modelsCacheTtlMs: 60000,
  previewChars: 500,
};
export type BridgeLimits = typeof DEFAULT_LIMITS;

export type BridgeConfig = {
  daemonSocket: string;
  token: string;
  allowDirectories: string[];
  allowModels: string[];
  allowRoBinds: string[];
  skillProfile: SkillProfile;
  listen: Listen;
} & Partial<BridgeLimits>;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;
const DAEMON_SOCKET = 'daemon socket';
const LISTEN_SOCKET = 'listen socket';

// Flag, then env var, then config-file key, then default. Every knob is a triplet; the token is
// the exception and is deliberately not a flag or a config key (see resolveToken).
const FLAGS = {
  config: { type: 'string' },
  'daemon-socket': { type: 'string' },
  'allowed-directories': { type: 'string' },
  'allowed-models': { type: 'string' },
  'allowed-ro-binds': { type: 'string' },
  'skill-profile': { type: 'string' },
  'listen-socket': { type: 'string' },
  'listen-port': { type: 'string' },
  'token-file': { type: 'string' },
  'daemon-timeout-ms': { type: 'string' },
  'list-timeout-ms': { type: 'string' },
  'models-cache-ttl-ms': { type: 'string' },
  'preview-chars': { type: 'string' },
} as const;

const FILE_KEYS = [
  'daemonSocket',
  'allowedDirectories',
  'allowedModels',
  'allowedRoBinds',
  'skillProfile',
  'listenSocket',
  'listenPort',
  'tokenFile',
  'daemonTimeoutMs',
  'listTimeoutMs',
  'modelsCacheTtlMs',
  'previewChars',
] as const;
type FileKey = (typeof FILE_KEYS)[number];
type FileConfig = Partial<Record<FileKey, unknown>>;

// A resolved value and how far down the precedence ladder it came from (0 flag, 1 env, 2 file).
type Found<T> = { value: T; rank: number };

function firstFound<T>(...candidates: (T | undefined)[]): Found<T> | undefined {
  for (const [rank, value] of candidates.entries()) {
    if (value !== undefined) return { value, rank };
  }
  return undefined;
}

// An empty env var is an unset one, the usual shell convention. An empty flag is an error.
const fromEnv = (env: Env, name: string) => (env[name] === '' ? undefined : env[name]);

function parseFlags(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

function defaultConfigFile(env: Env) {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'taskferry-mcp', 'config.json');
}

function readFileConfig(file: string, required: boolean): FileConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (!required && errorCode(e) === 'ENOENT') return {};
    throw new ConfigError(`cannot read config file ${file}: ${(e as Error).message}`, { cause: e });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config file ${file} is not valid JSON: ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config file ${file} must be a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown config key "${key}" in ${file}`);
    }
  }
  return parsed as FileConfig;
}

function asString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${name} must be a non-empty string`);
  }
  return value;
}

function absolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path, got "${value}"`);
  }
  return value;
}

function asList(name: string, value: unknown, separator: string): string[] {
  if (typeof value === 'string') return value.split(separator).filter(Boolean);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '')) return value;
  throw new ConfigError(`${name} must be a list of non-empty strings`);
}

function asBindRoots(name: string, value: unknown): string[] {
  return asList(name, value, ':').map((entry) => {
    const root = absolute(name, entry);
    if (root === path.parse(root).root) {
      throw new ConfigError(`${name} must not be the filesystem root`);
    }
    return root;
  });
}

function asSkillProfile(name: string, value: unknown): SkillProfile {
  if (!isSkillProfile(value)) {
    throw new ConfigError(`${name} must be one of ${SKILL_PROFILES.join(', ')}`);
  }
  return value;
}

function asPort(name: string, value: unknown): number {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `${name} must be an integer from 1 to 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

function resolveDaemonSocket(flag: string | undefined, env: Env, file: FileConfig): string {
  const found = firstFound<unknown>(flag, fromEnv(env, 'TASKFERRY_SOCKET_PATH'), file.daemonSocket);
  if (found) return absolute(DAEMON_SOCKET, asString(DAEMON_SOCKET, found.value));
  // The daemon's own default (src/paths.js there): <runtime dir>/daemon.sock.
  const runtime =
    fromEnv(env, 'TASKFERRY_RUNTIME_DIR') ??
    (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'taskferry') : undefined);
  if (!runtime) {
    throw new ConfigError(
      'daemon socket not set: pass --daemon-socket, set TASKFERRY_SOCKET_PATH, or set XDG_RUNTIME_DIR',
    );
  }
  return absolute(DAEMON_SOCKET, path.join(runtime, 'daemon.sock'));
}

function resolveListen(
  flags: { 'listen-socket'?: string; 'listen-port'?: string },
  env: Env,
  file: FileConfig,
): Listen {
  const socket = firstFound<unknown>(
    flags['listen-socket'],
    fromEnv(env, 'TASKFERRY_MCP_LISTEN_SOCKET'),
    file.listenSocket,
  );
  const port = firstFound<unknown>(
    flags['listen-port'],
    fromEnv(env, 'TASKFERRY_MCP_LISTEN_PORT'),
    file.listenPort,
  );
  if (socket && port && socket.rank === port.rank) {
    throw new ConfigError('set only one of listen-port and listen-socket from the same source');
  }
  if (port && (!socket || port.rank < socket.rank)) {
    return { kind: 'tcp', port: asPort('listen port', port.value) };
  }
  if (socket) {
    return {
      kind: 'unix',
      path: absolute(LISTEN_SOCKET, asString(LISTEN_SOCKET, socket.value)),
    };
  }
  if (!env.XDG_RUNTIME_DIR) {
    throw new ConfigError(
      'listen socket not set: pass --listen-socket, set TASKFERRY_MCP_LISTEN_SOCKET, or set XDG_RUNTIME_DIR',
    );
  }
  return {
    kind: 'unix',
    path: absolute(LISTEN_SOCKET, path.join(env.XDG_RUNTIME_DIR, 'taskferry-mcp', 'mcp.sock')),
  };
}

// The bearer token comes from TASKFERRY_MCP_TOKEN or from a file only. A flag would show up in
// `ps`, and a config key would travel with a config file that gets copied, diffed and backed up.
function resolveToken(tokenFile: Found<unknown> | undefined, env: Env): string {
  const direct = env.TASKFERRY_MCP_TOKEN?.trim() || undefined;
  if (direct !== undefined && tokenFile) {
    throw new ConfigError('set either TASKFERRY_MCP_TOKEN or a token file, not both');
  }
  if (direct !== undefined) return direct;
  if (!tokenFile) {
    throw new ConfigError(
      'bearer token required: set TASKFERRY_MCP_TOKEN, or pass --token-file / set TASKFERRY_MCP_TOKEN_FILE',
    );
  }
  const file = absolute('token file', asString('token file', tokenFile.value));
  let mode: number;
  let text: string;
  try {
    mode = statSync(file).mode & 0o777;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read token file ${file}: ${(e as Error).message}`, { cause: e });
  }
  if (mode & 0o077) {
    throw new ConfigError(
      `token file ${file} has mode ${mode.toString(8)}; it must not be readable by group or others (chmod 600)`,
    );
  }
  const token = text.trim();
  if (token === '') throw new ConfigError(`token file ${file} is empty`);
  return token;
}

export function resolveConfig({
  argv,
  env,
}: {
  argv: string[];
  env: Env;
}): BridgeConfig & BridgeLimits {
  const flags = parseFlags(argv);
  const explicitFile = firstFound(flags.config, fromEnv(env, 'TASKFERRY_MCP_CONFIG'));
  const file = explicitFile
    ? readFileConfig(absolute('config file', explicitFile.value), true)
    : readFileConfig(defaultConfigFile(env), false);

  const directories = firstFound<unknown>(
    flags['allowed-directories'],
    fromEnv(env, 'TASKFERRY_ALLOWED_DIRECTORIES'),
    file.allowedDirectories,
  );
  const models = firstFound<unknown>(
    flags['allowed-models'],
    fromEnv(env, 'TASKFERRY_ALLOWED_MODELS'),
    file.allowedModels,
  );
  const roBinds = firstFound<unknown>(
    flags['allowed-ro-binds'],
    fromEnv(env, 'TASKFERRY_ALLOWED_RO_BINDS'),
    file.allowedRoBinds,
  );
  const skillProfile = firstFound<unknown>(
    flags['skill-profile'],
    fromEnv(env, 'TASKFERRY_MCP_SKILL_PROFILE'),
    file.skillProfile,
  );
  const tokenFile = firstFound<unknown>(
    flags['token-file'],
    fromEnv(env, 'TASKFERRY_MCP_TOKEN_FILE'),
    file.tokenFile,
  );

  return {
    ...resolveLimits(flags, env, file),
    daemonSocket: resolveDaemonSocket(flags['daemon-socket'], env, file),
    token: resolveToken(tokenFile, env),
    allowDirectories: directories
      ? asList('allowed directories', directories.value, ':').map((d) =>
          absolute('allowed directory', d),
        )
      : [],
    allowModels: models ? asList('allowed models', models.value, ',') : [],
    allowRoBinds: roBinds ? asBindRoots('allowed read-only binds', roBinds.value) : [],
    skillProfile: skillProfile ? asSkillProfile('skill profile', skillProfile.value) : 'worker',
    listen: resolveListen(flags, env, file),
  };
}

function positiveInt(name: string, value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new ConfigError(`${name} must be a positive safe integer`);
  }
  return number;
}

function resolveLimits(flags: ReturnType<typeof parseFlags>, env: Env, file: FileConfig) {
  const limit = (key: FileKey, flag: keyof typeof FLAGS, variable: string, fallback: number) => {
    const found = firstFound<unknown>(flags[flag], fromEnv(env, variable), file[key]);
    return positiveInt(key, found ? found.value : fallback);
  };
  return {
    daemonTimeoutMs: limit(
      'daemonTimeoutMs',
      'daemon-timeout-ms',
      'TASKFERRY_MCP_DAEMON_TIMEOUT_MS',
      DEFAULT_LIMITS.daemonTimeoutMs,
    ),
    listTimeoutMs: limit(
      'listTimeoutMs',
      'list-timeout-ms',
      'TASKFERRY_MCP_LIST_TIMEOUT_MS',
      DEFAULT_LIMITS.listTimeoutMs,
    ),
    modelsCacheTtlMs: limit(
      'modelsCacheTtlMs',
      'models-cache-ttl-ms',
      'TASKFERRY_MCP_MODELS_CACHE_TTL_MS',
      DEFAULT_LIMITS.modelsCacheTtlMs,
    ),
    previewChars: limit(
      'previewChars',
      'preview-chars',
      'TASKFERRY_MCP_PREVIEW_CHARS',
      DEFAULT_LIMITS.previewChars,
    ),
  };
}

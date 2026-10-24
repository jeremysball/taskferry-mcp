import path from 'node:path';
import { ConfigError } from './errors.ts';

export type Env = Record<string, string | undefined>;

// A resolved value and how far down the precedence ladder it came from (0 flag, 1 env, 2 file).
export type Found<T> = { value: T; rank: number };

export function firstFound<T>(...candidates: (T | undefined)[]): Found<T> | undefined {
  for (const [rank, value] of candidates.entries()) {
    if (value !== undefined) return { value, rank };
  }
  return undefined;
}

// An empty env var is an unset one, the usual shell convention. An empty flag is an error.
export const fromEnv = (env: Env, name: string) => (env[name] === '' ? undefined : env[name]);

export function asString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${name} must be a non-empty string`);
  }
  return value;
}

export function absolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path, got "${value}"`);
  }
  return value;
}

export function asPort(name: string, value: unknown): number {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `${name} must be an integer from 1 to 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

export const FILE_KEYS = [
  'daemonSocket',
  'allowedDirectories',
  'allowedModels',
  'allowedRoBinds',
  'skillProfile',
  'skillRoot',
  'serverRoBinds',
  'listenSocket',
  'listenPort',
  'tokenFile',
  'gatewayPort',
  'gatewayTokenFile',
  'daemonTimeoutMs',
  'listTimeoutMs',
  'modelsCacheTtlMs',
  'previewChars',
] as const;
export type FileKey = (typeof FILE_KEYS)[number];
export type FileConfig = Partial<Record<FileKey, unknown>>;

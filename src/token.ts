import { readFileSync, statSync } from 'node:fs';
import { ConfigError } from './errors.ts';
import { absolute, asString, fromEnv, type Env, type Found } from './config-primitives.ts';

// A token comes from its env var or from a file only. A flag would show up in `ps`, and a config
// key would travel with a config file that gets copied, diffed and backed up.
export type TokenSource = {
  env: Env;
  tokenFile: Found<unknown> | undefined;
  directName: string;
  flagName: string;
  fileEnvName: string;
  label: string;
};

export function resolveToken(source: TokenSource): string {
  const { env, tokenFile, directName, flagName, fileEnvName, label } = source;
  const rawDirect = fromEnv(env, directName);
  const direct = rawDirect?.trim();
  if (rawDirect !== undefined && direct === '') {
    throw new ConfigError(`${directName} is set but empty`);
  }
  if (direct !== undefined && tokenFile) {
    throw new ConfigError(`set either ${directName} or a token file, not both`);
  }
  if (direct !== undefined) return direct;
  if (!tokenFile) {
    throw new ConfigError(
      `${label} required: set ${directName}, or pass ${flagName} / set ${fileEnvName}`,
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

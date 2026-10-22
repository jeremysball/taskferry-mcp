import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

let cache: { at: number; models: string[] } | undefined;

// The bridge only needs the installed model ids. OpenCode 2.x dropped
// `models --verbose`, so variant discovery stays out of this path; the
// dispatch variant is passed straight to the executor.
export async function listOpencodeModels(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('opencode', ['models'], {
      encoding: 'utf8',
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    throw new Error(
      `model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const models = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()))]
    .filter((line) => line !== '' && !line.includes(' '))
    .sort();
  cache = { at: Date.now(), models };
  return models;
}

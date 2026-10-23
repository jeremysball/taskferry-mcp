import {
  type Dirent,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Json } from './daemon.ts';
import { inAllowedRoot } from './scope.ts';
import { READ_ONLY, asText, inScopeStatus, nonBlank, type ToolScope } from './tools-shared.ts';

const MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;
const MAX_OFFSET = 10_000_000;
const DENIED_PREFIX = 'path denied';
const DENIED_RELATIVE = 'path denied: must be relative to the task directory';
const DENIED_OUTSIDE = 'path denied: outside the task directory';
const PATH_UNAVAILABLE = 'path unavailable';
const PATH_NOT_FOUND = 'path not found';

const worktreeArgs = z.strictObject({
  taskId: nonBlank,
  path: nonBlank.max(4096).optional(),
  offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
  maxBytes: z.number().int().min(1).max(HARD_MAX_BYTES).optional(),
});

type WorktreeArgs = z.infer<typeof worktreeArgs>;
type EntryType = 'file' | 'directory' | 'symlink' | 'other';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function resolveTaskRoot(taskId: string, scope: ToolScope) {
  const current = (await inScopeStatus(taskId, scope)) as Json | null;
  const directory = current?.directory;
  if (typeof directory !== 'string') throw new Error('workspace unavailable');
  try {
    return realpathSync(directory);
  } catch (error) {
    throw new Error('workspace unavailable', { cause: error });
  }
}

// Resolve a caller path against the task directory and require the result to
// stay inside it after symlinks are followed. A path that does not exist is
// reported as missing; it never falls back to the unresolved string.
function resolvePath(root: string, requested: string | undefined) {
  const relative = requested ?? '.';
  if (path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error(DENIED_RELATIVE);
  }
  let target: string;
  try {
    target = realpathSync(path.resolve(root, relative));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(PATH_NOT_FOUND, { cause: error });
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
  if (!inAllowedRoot([root], target)) throw new Error(DENIED_OUTSIDE);
  return { target, relative: path.relative(root, target) || '.' };
}

function entryType(dirent: Dirent): EntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

function entrySize(fullPath: string, type: EntryType) {
  if (type !== 'file' && type !== 'symlink') return undefined;
  try {
    return lstatSync(fullPath).size;
  } catch {
    return undefined;
  }
}

function compareNames(a: Dirent, b: Dirent) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function listDirectory(taskId: string, root: string, target: string, relative: string) {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    throw new Error('directory unavailable', { cause: error });
  }
  const total = dirents.length;
  const entries = dirents
    .slice()
    .sort(compareNames)
    .slice(0, MAX_ENTRIES)
    .map((dirent) => {
      const type = entryType(dirent);
      const size = entrySize(path.join(target, dirent.name), type);
      return { type, name: dirent.name, ...(size === undefined ? {} : { size }) };
    });
  return {
    entries,
    total,
    taskId,
    directory: root,
    path: relative,
    kind: 'directory',
    truncated: total > MAX_ENTRIES,
  };
}

function openRead(target: string) {
  try {
    return openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(PATH_NOT_FOUND, { cause: error });
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
}

// The path was resolved before opening, but a worker could still swap a path
// component between realpath and open. Check the opened descriptor's real path
// as well, the same fd-based guard TaskFerry's output reader uses.
function assertFdInside(root: string, fd: number) {
  let opened: string;
  try {
    opened = realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return;
  }
  if (!inAllowedRoot([root], opened)) throw new Error(DENIED_OUTSIDE);
}

function readWorktreeFile(
  taskId: string,
  root: string,
  target: string,
  relative: string,
  options: { offset: number; maxBytes: number },
) {
  const { offset, maxBytes } = options;
  const fd = openRead(target);
  try {
    const stat = fstatSync(fd);
    assertFdInside(root, fd);
    if (!stat.isFile()) {
      return {
        taskId,
        directory: root,
        path: relative,
        kind: 'other',
        size: stat.size,
        content: null,
        note: 'not a regular file',
      };
    }
    const size = stat.size;
    const start = Math.min(offset, size);
    const length = Math.min(maxBytes, size - start);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = length === 0 ? 0 : readSync(fd, buffer, 0, length, start);
    const chunk = buffer.subarray(0, bytesRead);
    const binary = chunk.includes(0) || !isUtf8(chunk);
    return {
      taskId,
      directory: root,
      path: relative,
      kind: 'file',
      size,
      offset: start,
      bytesRead,
      truncated: start + bytesRead < size,
      binary,
      content: binary ? null : chunk.toString('utf8'),
      ...(binary ? { note: 'binary file; content omitted' } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(DENIED_PREFIX)) throw error;
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  } finally {
    closeSync(fd);
  }
}

async function viewWorktree(args: WorktreeArgs, scope: ToolScope) {
  const root = await resolveTaskRoot(args.taskId, scope);
  const { target, relative } = resolvePath(root, args.path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch (error) {
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
  if (stat.isDirectory()) return listDirectory(args.taskId, root, target, relative);
  if (stat.isFile()) {
    return readWorktreeFile(args.taskId, root, target, relative, {
      offset: args.offset ?? 0,
      maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES,
    });
  }
  return {
    taskId: args.taskId,
    directory: root,
    path: relative,
    kind: 'other',
    size: stat.size,
    content: null,
    note: 'not a regular file or directory',
  };
}

export function registerWorktreeTool(server: McpServer, scope: ToolScope) {
  server.registerTool(
    'taskferry_worktree',
    {
      description:
        'Browse a task dispatch directory read-only. Omit path to list the root; a directory path lists that directory; a file path returns its text. Paths are relative and must stay inside the task directory after symlink resolution. Large files page with offset and maxBytes; binary files return metadata without content. This first reads task status to enforce the workspace allowlist.',
      inputSchema: worktreeArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await viewWorktree(args, scope)),
  );
}

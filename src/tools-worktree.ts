import { type Dirent, type Stats, constants } from 'node:fs';
import { open, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Json } from './daemon.ts';
import { inResolvedRoot } from './scope.ts';
import { errorCode } from './errors.ts';
import {
  READ_ONLY,
  asText,
  assertAllowedDirectory,
  inScopeStatus,
  nonBlank,
  type ToolScope,
} from './tools-shared.ts';

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

async function resolveTaskRoot(taskId: string, scope: ToolScope) {
  const current = (await inScopeStatus(taskId, scope)) as Json | null;
  const directory = current?.directory;
  if (typeof directory !== 'string') throw new Error('workspace unavailable');
  return assertAllowedDirectory(directory, scope);
}

// Resolve a caller path against the task directory and require the result to
// stay inside it after symlinks are followed. A path that does not exist is
// reported as missing; it never falls back to the unresolved string.
async function resolvePath(root: string, requested: string | undefined) {
  const relative = requested ?? '.';
  if (path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error(DENIED_RELATIVE);
  }
  let target: string;
  try {
    target = await realpath(path.resolve(root, relative));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(PATH_NOT_FOUND, { cause: error });
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
  if (!(await inResolvedRoot([root], target))) throw new Error(DENIED_OUTSIDE);
  return { target, relative: path.relative(root, target) || '.' };
}

function entryType(dirent: Dirent): EntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function entrySize(fullPath: string, type: EntryType) {
  if (type !== 'file' && type !== 'symlink') return undefined;
  try {
    return (await lstat(fullPath)).size;
  } catch {
    return undefined;
  }
}

function compareNames(a: Dirent, b: Dirent) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

async function listDirectory(taskId: string, root: string, target: string, relative: string) {
  let dirents: Dirent[];
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (error) {
    throw new Error('directory unavailable', { cause: error });
  }
  const total = dirents.length;
  const entries = await Promise.all(
    dirents
      .slice()
      .sort(compareNames)
      .slice(0, MAX_ENTRIES)
      .map(async (dirent) => {
        const type = entryType(dirent);
        const size = await entrySize(path.join(target, dirent.name), type);
        return { type, name: dirent.name, ...(size === undefined ? {} : { size }) };
      }),
  );
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

async function openRead(target: string) {
  try {
    return await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(PATH_NOT_FOUND, { cause: error });
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
}

// The path was resolved before opening, but a worker could still swap a path
// component between realpath and open. Check the opened descriptor's real path
// as well, the same fd-based guard TaskFerry's output reader uses.
async function assertFdInside(root: string, fd: number) {
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    let opened: string;
    try {
      opened = await realpath(`${base}/${fd}`);
    } catch {
      continue;
    }
    if (!(await inResolvedRoot([root], opened))) throw new Error(DENIED_OUTSIDE);
    return;
  }
  throw new Error(PATH_UNAVAILABLE);
}

function characterBoundary(buffer: Buffer, index: number): { before: number; after: number } {
  const continuation = (at: number) =>
    at >= 0 && at < buffer.length && (buffer[at] & 0xc0) === 0x80;
  if (!continuation(index)) return { before: index, after: index };
  let before = index;
  while (before > 0 && index - before < 3 && continuation(before)) before--;
  let after = index;
  while (after < buffer.length && after - before < 4 && continuation(after)) after++;
  return isUtf8(buffer.subarray(before, after))
    ? { before, after }
    : { before: index, after: index };
}

async function readPage(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
  offset: number,
  maxBytes: number,
) {
  const requested = Math.min(offset, size);
  const windowStart = Math.max(0, requested - 3);
  // Look around both edges so a split character is not mistaken for binary data.
  const buffer = Buffer.allocUnsafe(
    Math.min(size - windowStart, requested - windowStart + maxBytes + 6),
  );
  const { bytesRead } = await file.read(buffer, 0, buffer.length, windowStart);
  const window = buffer.subarray(0, bytesRead);
  const start = characterBoundary(window, Math.min(requested - windowStart, bytesRead)).after;
  const edge = characterBoundary(window, Math.min(start + maxBytes, bytesRead));
  // A page smaller than one character still has to advance.
  const end = edge.before > start ? edge.before : edge.after;
  return { start: windowStart + start, chunk: window.subarray(start, end) };
}

async function readWorktreeFile(
  taskId: string,
  root: string,
  target: string,
  relative: string,
  options: { offset: number; maxBytes: number },
) {
  const { offset, maxBytes } = options;
  const file = await openRead(target);
  try {
    const stat = await file.stat();
    await assertFdInside(root, file.fd);
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
    const { start, chunk } = await readPage(file, size, offset, maxBytes);
    const bytesRead = chunk.length;
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
    await file.close();
  }
}

async function viewWorktree(args: WorktreeArgs, scope: ToolScope) {
  const root = await resolveTaskRoot(args.taskId, scope);
  const { target, relative } = await resolvePath(root, args.path);
  let info: Stats;
  try {
    info = await stat(target);
  } catch (error) {
    throw new Error(PATH_UNAVAILABLE, { cause: error });
  }
  if (info.isDirectory()) {
    return {
      ...(await listDirectory(args.taskId, root, target, relative)),
      ...(args.offset !== undefined || args.maxBytes !== undefined
        ? { note: 'offset and maxBytes apply to file reads only' }
        : {}),
    };
  }
  if (info.isFile()) {
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
    size: info.size,
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

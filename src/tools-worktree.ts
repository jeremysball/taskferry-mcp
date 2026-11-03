import { type Dirent, type Stats, constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Json } from './daemon.ts';
import { inResolvedRoot } from './scope.ts';
import { errorCode } from './errors.ts';
import { type FilePage, compareNames, entrySize, entryType, readPage } from './file-inspect.ts';
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
const DENIED_PREFIX = 'path denied';
const DENIED_RELATIVE = 'path denied: must be relative to the task directory';
const DENIED_OUTSIDE = 'path denied: outside the task directory';
const PATH_UNAVAILABLE = 'path unavailable';
const PATH_NOT_FOUND = 'path not found';

const worktreeArgs = z.strictObject({
  taskId: nonBlank,
  path: nonBlank.max(4096).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxBytes: z.number().int().min(1).max(HARD_MAX_BYTES).optional(),
});

type WorktreeArgs = z.infer<typeof worktreeArgs>;

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

function worktreeFileNotes(page: FilePage, binary: boolean, bytesRead: number) {
  const notes: string[] = [];
  if (binary) notes.push('binary file; content omitted');
  if (page.sizeUnknown && bytesRead > 0) {
    notes.push('reported size is 0; read directly from the descriptor');
  }
  if (page.adjustedFrom !== undefined) {
    notes.push(
      `offset ${page.adjustedFrom} is inside a UTF-8 character; page starts at ${page.start}`,
    );
  }
  return notes;
}

function worktreeFileResult(
  taskId: string,
  root: string,
  relative: string,
  size: number,
  page: FilePage,
) {
  const bytesRead = page.chunk.length;
  const binary = page.chunk.includes(0) || !isUtf8(page.chunk);
  const notes = worktreeFileNotes(page, binary, bytesRead);
  return {
    taskId,
    directory: root,
    path: relative,
    kind: 'file',
    size,
    ...(page.sizeUnknown && bytesRead > 0 ? { sizeUnknown: true } : {}),
    offset: page.start,
    bytesRead,
    truncated: page.truncated,
    ...(page.truncated ? { nextOffset: page.start + bytesRead } : {}),
    binary,
    content: binary ? null : page.chunk.toString('utf8'),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
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
    const page = await readPage(file, stat.size, offset, maxBytes);
    return worktreeFileResult(taskId, root, relative, stat.size, page);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith(DENIED_PREFIX) || !errorCode(error))) {
      throw error;
    }
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
        'Browse a task dispatch directory read-only. Omit path to list the root; a directory path lists that directory; a file path returns its text. Paths are relative and must stay inside the task directory after symlink resolution. Large files page with offset and maxBytes; offset has no upper cap, and a truncated page reports nextOffset. A page never ends inside a UTF-8 character. Binary files return metadata without content. Zero-size virtual files are read directly and flagged with sizeUnknown. This first reads task status to enforce the workspace allowlist.',
      inputSchema: worktreeArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await viewWorktree(args, scope)),
  );
}

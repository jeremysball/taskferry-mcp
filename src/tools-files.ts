import { isUtf8 } from 'node:buffer';
import { constants, existsSync, type Stats } from 'node:fs';
import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import {
  STANDARD_BASE64,
  assertAbsolute,
  pathError,
  requestedPath,
  resolvePath,
  targetText,
} from './absolute-path.ts';
import { errorCode } from './errors.ts';
import { DEFAULT_MAX_BYTES, MAX_ENTRIES, filesArgs, type FilesArgs } from './tools-files-schema.ts';
import {
  type DirectoryScan,
  type FilePage,
  type ScanCursor,
  entrySize,
  readPage,
  scanDirectory,
} from './file-inspect.ts';
import { READ_ONLY, asText } from './tools-shared.ts';

async function descriptorPath(fd: number, fallback: string | Buffer) {
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    try {
      return await realpath(`${base}/${fd}`);
    } catch {
      continue;
    }
  }
  return targetText(fallback);
}

function descriptorReadPath(fd: number) {
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    if (existsSync(base)) return `${base}/${fd}`;
  }
  return undefined;
}

async function openRead(requested: string, target: string | Buffer) {
  try {
    // O_NONBLOCK keeps a path that becomes a FIFO between stat and open from
    // hanging the bridge; the fstat check below turns it into `kind: "other"`.
    return await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw pathError(requested, error);
  }
}

async function openDirectory(requested: string, target: string | Buffer) {
  try {
    return await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw pathError(requested, error);
  }
}

// A raw-name cursor is only needed when the decoded name is not reversible.
// Plain `after` stays the friendly form; base64 is the exact one.
function decodeCursor(value: string) {
  if (value.length === 0 || !STANDARD_BASE64.test(value)) {
    throw new Error('afterBase64 must be non-empty standard base64');
  }
  return Buffer.from(value, 'base64');
}

function rawPath(dir: string | Buffer, name: Buffer) {
  const prefix = Buffer.isBuffer(dir) ? dir : Buffer.from(dir, 'utf8');
  const separator =
    prefix.length > 0 && prefix[prefix.length - 1] === 0x2f ? [] : [Buffer.from(path.sep)];
  return Buffer.concat([prefix, ...separator, name]);
}

function isLossless(name: string, raw: Buffer) {
  return Buffer.from(name, 'utf8').equals(raw);
}

function directoryNotes(
  scan: DirectoryScan,
  afterLabel: string | undefined,
  maxBytes: number | undefined,
  lossyCursor: boolean,
) {
  const notes: string[] = [];
  if (scan.total === 0) notes.push('directory is empty');
  if (afterLabel !== undefined && scan.total > 0 && scan.matches === 0) {
    notes.push(`no entries after ${JSON.stringify(afterLabel)} (${scan.total} entries total)`);
  }
  if (lossyCursor) {
    notes.push(
      'the next entry name is not valid UTF-8; continue with nextAfterBase64, not nextAfter',
    );
  }
  if (maxBytes !== undefined) notes.push('maxBytes applies to file reads only');
  return notes;
}

function cursorFor(args: FilesArgs): { cursor?: ScanCursor; label?: string } {
  if (args.after !== undefined && args.afterBase64 !== undefined) {
    throw new Error('after and afterBase64 are mutually exclusive');
  }
  if (args.afterBase64 !== undefined) {
    const raw = decodeCursor(args.afterBase64);
    return { cursor: { name: raw.toString('utf8'), raw }, label: raw.toString('utf8') };
  }
  if (args.after !== undefined) {
    return {
      cursor: { name: args.after, raw: Buffer.from(args.after, 'utf8') },
      label: args.after,
    };
  }
  return {};
}

function cursorEcho(args: FilesArgs) {
  if (args.after !== undefined) return { after: args.after };
  if (args.afterBase64 !== undefined) return { afterBase64: args.afterBase64 };
  return {};
}

async function mapEntries(readPath: string | Buffer, scan: DirectoryScan) {
  return Promise.all(
    scan.entries.map(async (entry) => {
      const size = await entrySize(rawPath(readPath, entry.raw), entry.type);
      return {
        type: entry.type,
        name: entry.name,
        ...(size === undefined ? {} : { size }),
        ...(isLossless(entry.name, entry.raw) ? {} : { nameBase64: entry.raw.toString('base64') }),
      };
    }),
  );
}

function pageCursor(scan: DirectoryScan, truncated: boolean) {
  if (!truncated) return { lossy: false, cursor: {} };
  const last = scan.entries[scan.entries.length - 1];
  const lossy = !isLossless(last.name, last.raw);
  return {
    lossy,
    cursor: {
      ...(lossy ? {} : { nextAfter: last.name }),
      nextAfterBase64: last.raw.toString('base64'),
    },
  };
}

async function listDirectory(requested: string, target: string | Buffer, args: FilesArgs) {
  if (args.offset !== undefined) {
    throw new Error('offset applies to file reads only; directory pages use after and nextAfter');
  }
  const { cursor, label } = cursorFor(args);
  const maxEntries = args.maxEntries ?? MAX_ENTRIES;
  const directory = await openDirectory(requested, target);
  try {
    const openedPath = await descriptorPath(directory.fd, target);
    const readPath = descriptorReadPath(directory.fd) ?? target;
    let scan: DirectoryScan;
    try {
      scan = await scanDirectory(readPath, cursor, maxEntries);
    } catch (error) {
      throw pathError(requested, error);
    }
    const entries = await mapEntries(readPath, scan);
    const truncated = scan.matches > entries.length;
    const { lossy, cursor: page } = pageCursor(scan, truncated);
    const notes = directoryNotes(scan, label, args.maxBytes, lossy);
    return {
      requested,
      path: openedPath,
      kind: 'directory',
      ...cursorEcho(args),
      total: scan.total,
      returned: entries.length,
      entries,
      truncated,
      ...page,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    };
  } finally {
    await directory.close().catch(() => {});
  }
}

function otherResult(requested: string, target: string, size: number, args: FilesArgs) {
  const notes = ['not a regular file or directory'];
  if (args.after !== undefined || args.afterBase64 !== undefined) {
    notes.push('after and afterBase64 apply to directory listings only');
  }
  if (args.maxEntries !== undefined) notes.push('maxEntries applies to directory listings only');
  return { requested, size, path: target, kind: 'other', content: null, note: notes.join('; ') };
}

async function readPageOrThrow(
  requested: string,
  file: FileHandle,
  size: number,
  offset: number,
  maxBytes: number,
) {
  try {
    return await readPage(file, size, offset, maxBytes);
  } catch (error) {
    if (errorCode(error)) throw pathError(requested, error);
    throw error;
  }
}

function emptyNote(page: FilePage, offset: number, size: number) {
  if (page.chunk.length > 0) return undefined;
  if (page.start === 0) return 'file is empty';
  if (page.readableEnd !== undefined && page.readableEnd < size)
    return `offset ${offset} is at or beyond the end of readable content (${page.readableEnd} bytes; reported size ${size})`;
  if (page.start >= size)
    return `offset ${offset} is at or beyond the end of the file (size ${size})`;
  return `no bytes returned at offset ${offset}`;
}

function pageNotes(page: FilePage, binary: boolean, offset: number, size: number) {
  const notes: string[] = [];
  if (page.adjustedFrom !== undefined) {
    notes.push(
      `offset ${page.adjustedFrom} is inside a UTF-8 character; page starts at ${page.start}`,
    );
  }
  if (binary) notes.push('binary page; content omitted');
  if (page.sizeUnknown && page.chunk.length > 0) {
    notes.push('reported size is 0; read directly from the descriptor');
  }
  const empty = emptyNote(page, offset, size);
  if (empty) notes.push(empty);
  return notes;
}

function filePageResult(
  requested: string,
  target: string,
  size: number,
  page: FilePage,
  details: { binary: boolean; notes: string[] },
) {
  const bytesRead = page.chunk.length;
  const virtual = page.sizeUnknown && bytesRead > 0;
  return {
    requested,
    size,
    ...(virtual ? { sizeUnknown: true } : {}),
    path: target,
    kind: 'file',
    offset: page.start,
    bytesRead,
    truncated: page.truncated,
    binary: details.binary,
    ...(page.truncated ? { nextOffset: page.start + bytesRead } : {}),
    content: details.binary ? null : page.chunk.toString('utf8'),
    ...(details.notes.length ? { note: details.notes.join('; ') } : {}),
  };
}

function fileArgNotes(notes: string[], args: FilesArgs) {
  if (args.after !== undefined) notes.push('after applies to directory listings only');
  if (args.afterBase64 !== undefined) notes.push('afterBase64 applies to directory listings only');
  if (args.maxEntries !== undefined) notes.push('maxEntries applies to directory listings only');
}

async function readFilePage(
  requested: string,
  target: string,
  file: FileHandle,
  size: number,
  args: FilesArgs,
) {
  const offset = args.offset ?? 0;
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const page = await readPageOrThrow(requested, file, size, offset, maxBytes);
  const binary = page.chunk.includes(0) || !isUtf8(page.chunk);
  const notes = pageNotes(page, binary, offset, size);
  fileArgNotes(notes, args);
  return filePageResult(requested, target, size, page, { binary, notes });
}

async function inspectFile(requested: string, target: string | Buffer, args: FilesArgs) {
  const file = await openRead(requested, target);
  try {
    let opened: Stats;
    try {
      opened = await file.stat();
    } catch (error) {
      throw pathError(requested, error);
    }
    const openedPath = await descriptorPath(file.fd, target);
    if (!opened.isFile()) {
      return otherResult(requested, openedPath, opened.size, args);
    }
    return await readFilePage(requested, openedPath, file, opened.size, args);
  } finally {
    await file.close().catch(() => {});
  }
}

// realpath rewrites a magic fd link to a path naming the pipe or socket
// itself, which either does not exist or is not a filesystem object. Statting
// the original path follows the kernel link and reports the real type.
async function specialOther(requested: string | Buffer, display: string, args: FilesArgs) {
  try {
    const direct = await stat(requested);
    if (!direct.isFile() && !direct.isDirectory()) {
      return otherResult(display, targetText(requested), direct.size, args);
    }
  } catch {
    // Keep the caller's original error.
  }
  return undefined;
}

async function inspectPath(args: FilesArgs) {
  const { display, raw } = requestedPath(args);
  const requested = raw ?? display;
  // Validate before the catch below so a relative path fails as such instead
  // of being statted relative to the process working directory.
  assertAbsolute(display, raw);
  let target: string | Buffer;
  try {
    target = await resolvePath(display, raw);
  } catch (error) {
    const special = await specialOther(requested, display, args);
    if (special !== undefined) return special;
    throw error;
  }
  let info: Stats;
  try {
    info = await stat(target);
  } catch (error) {
    const special = await specialOther(requested, display, args);
    if (special !== undefined) return special;
    throw pathError(display, error);
  }
  if (info.isDirectory()) return listDirectory(display, target, args);
  if (info.isFile()) return inspectFile(display, target, args);
  return otherResult(display, targetText(target), info.size, args);
}

export function registerFilesTool(server: McpServer) {
  server.registerTool(
    'taskferry_files',
    {
      description:
        'List a directory or read a regular file at any absolute path the MCP process OS user can access. Exposed on both authenticated MCP surfaces, the bridge and the gateway; a gateway token therefore carries the same host-read authority as the bridge token. This tool is not task-scoped, needs no task id, ignores the workspace allowlist, and follows symlinks to their target. Authentication on either surface and the service user filesystem permissions are the boundary. Pass path normally, or pass pathBase64 with the raw bytes of the absolute path when a component name is not valid UTF-8; the two are mutually exclusive. A directory returns a name-sorted page: after resumes after an entry name (exclusive), maxEntries defaults to 500, total is the exact entry count, and nextAfter continues the listing. If the boundary entry name is not valid UTF-8, the page omits nextAfter and reports nextAfterBase64 instead; pass that as afterBase64 so no sibling can be skipped. Entries with such names also carry nameBase64. offset is file-only. Each directory page scans the whole directory to keep exact order and total, so a very large directory costs time proportional to its entry count. A file returns UTF-8 text: offset is a byte offset with no cap, maxBytes defaults to 262144 (maximum 1048576), and nextOffset continues the read. A page never ends inside a UTF-8 character; if maxBytes is smaller than the next character, the page includes that character and can exceed maxBytes by up to 3 bytes. An offset inside a character starts the page at that character and says so. Binary detection is per page; a page containing NUL or invalid UTF-8 returns binary: true and no content. A zero stat size is read directly, which covers procfs and similar virtual files; a sysfs attribute that reports a padded stat size still ends at its short read instead of reporting a false truncation. A descriptor that rejects offset reads is retried sequentially, so procfs entries page with a small maxBytes too. Empty directories, empty files, binary pages, and offsets at or beyond EOF are stated explicitly. Errors distinguish a missing path, a permission denial, a symlink loop, and a non-directory path.',
      inputSchema: filesArgs,
      annotations: READ_ONLY,
    },
    async (args) => asText(await inspectPath(args)),
  );
}

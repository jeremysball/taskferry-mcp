import { isUtf8 } from 'node:buffer';
import { type Dirent } from 'node:fs';
import { type FileHandle, lstat, opendir } from 'node:fs/promises';

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export function entryType(dirent: Dirent): EntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

export async function entrySize(fullPath: string | Buffer, type: EntryType) {
  if (type !== 'file' && type !== 'symlink') return undefined;
  try {
    return (await lstat(fullPath)).size;
  } catch {
    return undefined;
  }
}

export function compareNames(a: { name: string }, b: { name: string }) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

// The display name is the UTF-8 decoding of the raw directory bytes, which is
// lossy for a name that is not valid UTF-8. Keeping the raw bytes lets the
// cursor order such names deterministically instead of colliding on U+FFFD.
export type ScanEntry = { name: string; raw: Buffer; type: EntryType };
export type ScanCursor = { name: string; raw: Buffer };
export type DirectoryScan = { entries: ScanEntry[]; total: number; matches: number };

function compareNamesAndBytes(a: ScanCursor, b: ScanCursor) {
  const names = compareNames(a, b);
  return names === 0 ? Buffer.compare(a.raw, b.raw) : names;
}

export function compareEntry(a: ScanEntry, b: ScanEntry) {
  return compareNamesAndBytes(a, b);
}

function toCursor(after: string | ScanCursor): ScanCursor {
  return typeof after === 'string' ? { name: after, raw: Buffer.from(after, 'utf8') } : after;
}

function siftUp(heap: ScanEntry[], index: number) {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareEntry(heap[parent], heap[index]) >= 0) return;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function siftDown(heap: ScanEntry[], index: number) {
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareEntry(heap[left], heap[largest]) > 0) largest = left;
    if (right < heap.length && compareEntry(heap[right], heap[largest]) > 0) largest = right;
    if (largest === index) return;
    [heap[index], heap[largest]] = [heap[largest], heap[index]];
    index = largest;
  }
}

// Count every entry while retaining only the `limit` smallest names after the
// cursor. Keeping a bounded heap means a huge directory costs O(limit) memory
// instead of one Dirent per entry, and the final sort is over the page window,
// not the whole directory. `total` and `matches` stay exact because the scan
// still visits every entry. A name cursor, rather than an index, lets a caller
// reach the tail of a directory without retaining every earlier entry.
function retainSmallest(entries: ScanEntry[], entry: ScanEntry, limit: number) {
  if (limit <= 0) return;
  if (entries.length < limit) {
    entries.push(entry);
    siftUp(entries, entries.length - 1);
    return;
  }
  if (compareEntry(entry, entries[0]) < 0) {
    entries[0] = entry;
    siftDown(entries, 0);
  }
}

export async function scanDirectory(
  dir: string | Buffer,
  after: string | ScanCursor | undefined,
  limit: number,
): Promise<DirectoryScan> {
  // Read raw name bytes so pagination can order names that do not decode to
  // distinct UTF-8 strings. Node accepts `encoding: "buffer"` but its
  // `BufferEncoding` type omits it, so the cast is confined to this call.
  const handle = await opendir(dir, { encoding: 'buffer' as unknown as 'utf8' });
  const cursor = after === undefined ? undefined : toCursor(after);
  const entries: ScanEntry[] = [];
  let total = 0;
  let matches = 0;
  try {
    for await (const dirent of handle) {
      total += 1;
      const rawName: unknown = dirent.name;
      const raw = Buffer.isBuffer(rawName) ? rawName : Buffer.from(String(rawName), 'utf8');
      const entry: ScanEntry = { name: raw.toString('utf8'), type: entryType(dirent), raw };
      if (cursor !== undefined && compareNamesAndBytes(entry, cursor) <= 0) continue;
      matches += 1;
      retainSmallest(entries, entry, limit);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  entries.sort(compareEntry);
  return { entries, total, matches };
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

const LOOKBEHIND = 3;
const LOOKAHEAD = 6;

// Short reads are normal on NFS and FUSE. Loop until the requested window is
// full or the descriptor reports EOF; a single read could otherwise return one
// byte, or zero, and leave the caller unable to advance.
export type ReadWindow = {
  buffer: Buffer;
  short: boolean;
  seekless: boolean;
  eofBeforeStart?: boolean;
  // The sequential fallback served prefix bytes before hitting EOF. That is
  // real evidence the readable content ended, even when it ended exactly at
  // the requested offset and left the window empty.
  sawBytes?: boolean;
  // A nonzero pread returned nothing and the bounded sequential fallback could
  // not run. The zero read is then not EOF evidence: a seekless descriptor
  // rejects every offset read, so its answer cannot be trusted.
  probeSkipped?: boolean;
};

// Some procfs and sysfs attributes reject every nonzero offset read while
// still serving a normal sequential read. Their reported size can also be a
// page-size placeholder rather than the readable content. When a pread at a
// nonzero offset returns nothing, retry from the descriptor's current offset
// (still zero, because preads do not move it) and discard the prefix. The cap
// keeps a bogus huge offset from turning the fallback into a large allocation.
const SEEK_FALLBACK_MAX = 4 * 1024 * 1024;
const SKIP_CHUNK = 64 * 1024;

type SequentialRead = { buffer: Buffer; reachedStart: boolean; sawBytes: boolean };

async function readSequential(
  file: FileHandle,
  start: number,
  length: number,
): Promise<SequentialRead | undefined> {
  if (length === 0 || start + length > SEEK_FALLBACK_MAX) return undefined;
  const buffer = Buffer.allocUnsafe(length);
  const scratch = Buffer.allocUnsafe(Math.min(SKIP_CHUNK, Math.max(1, start)));
  let skipped = 0;
  let sawBytes = false;
  while (skipped < start) {
    const want = Math.min(scratch.length, start - skipped);
    const { bytesRead } = await file.read(scratch, 0, want, null);
    if (bytesRead === 0) return { buffer: Buffer.alloc(0), reachedStart: false, sawBytes };
    sawBytes = true;
    skipped += bytesRead;
  }
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return { buffer: buffer.subarray(0, filled), reachedStart: true, sawBytes: true };
}

async function readWindow(file: FileHandle, start: number, length: number): Promise<ReadWindow> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled === 0 && start > 0) {
    const sequential = await readSequential(file, start, length);
    if (sequential !== undefined) {
      return {
        buffer: sequential.buffer,
        short: sequential.buffer.length < length,
        seekless: true,
        eofBeforeStart: !sequential.reachedStart && sequential.sawBytes,
        sawBytes: sequential.sawBytes,
      };
    }
  }
  return {
    buffer: buffer.subarray(0, filled),
    short: filled < length,
    seekless: false,
    // `filled === 0` at a nonzero start is ambiguous until the fallback runs.
    // If it could not (length zero or beyond its cap), the zero read must not
    // be read as EOF.
    probeSkipped: filled === 0 && start > 0,
  };
}

async function hasMore(file: FileHandle, at: number, seekless: boolean) {
  const probe = Buffer.allocUnsafe(1);
  try {
    // A seekless window leaves the descriptor offset at `at`, so a normal read
    // asks the same question without an offset.
    const { bytesRead } = await file.read(probe, 0, 1, seekless ? null : at);
    return bytesRead > 0;
  } catch {
    // If EOF cannot be probed, keep the page continuable; the caller can retry.
    // Never turn a failed probe into `truncated: false`, which would claim
    // there is no more content when the descriptor could not answer.
    return true;
  }
}

// A short window proves the readable content ended, but a regular file that
// shrank while it was open must still ask the caller to retry. Re-stat is the
// distinction: a shrunken regular file reports a different size now, while a
// sysfs attribute keeps its padded page-sized placeholder.
async function shortWindowPage(
  file: FileHandle,
  plan: ReadPlan,
  size: number,
  window: ReadWindow,
  offset: number,
): Promise<FilePage | undefined> {
  if (plan.sizeUnknown) return undefined;
  if (!window.short) return undefined;
  const readableEnd = plan.start + window.buffer.length;
  if (plan.requested <= readableEnd) return undefined;
  const current = await recheckSize(file);
  if (current !== undefined && current !== size) throw nonAdvancing(offset);
  return {
    start: plan.requested,
    chunk: Buffer.alloc(0),
    truncated: false,
    sizeUnknown: false,
    ...(readableEnd < size ? { readableEnd } : {}),
  };
}

async function recheckSize(file: FileHandle) {
  const stat = (file as { stat?: FileHandle['stat'] }).stat;
  if (typeof stat !== 'function') return undefined;
  try {
    return (await stat.call(file)).size;
  } catch {
    return undefined;
  }
}

export type FilePage = {
  start: number;
  chunk: Buffer;
  truncated: boolean;
  sizeUnknown: boolean;
  adjustedFrom?: number;
  readableEnd?: number;
};

type ReadPlan = { start: number; length: number; requested: number; sizeUnknown: boolean };

function planRead(size: number, offset: number, maxBytes: number): ReadPlan {
  const sizeUnknown = size === 0;
  const requested = sizeUnknown ? Math.max(0, offset) : Math.min(Math.max(0, offset), size);
  const start = Math.max(0, requested - LOOKBEHIND);
  const wanted = requested - start + maxBytes + LOOKAHEAD;
  const length = sizeUnknown ? wanted : Math.min(wanted, Math.max(0, size - start));
  return { start, length, requested, sizeUnknown };
}

function nonAdvancing(offset: number) {
  return new Error(`file changed while reading: offset ${offset} did not advance; retry the read`);
}

// A size of zero is normal for procfs, so a zero read at a nonzero offset is
// ambiguous: a seekless descriptor rejects offset reads and still has content.
// When the bounded sequential fallback cannot run, say so instead of claiming
// the file ended.
function unprobeable(offset: number) {
  return new Error(
    `cannot tell whether more content follows offset ${offset}: the reported size is 0 and the sequential fallback limit was reached`,
  );
}

async function pageTruncated(
  file: FileHandle,
  plan: ReadPlan,
  size: number,
  window: ReadWindow,
  end: number,
) {
  // Content beyond the page but already in the window is a real continuation.
  if (end < window.buffer.length) return true;
  // A window that stopped before the planned length hit EOF, so there is no
  // continuation even when the stat size is larger than the readable content
  // (a sysfs attribute reports a page-sized length for a few bytes).
  if (window.short) return false;
  if (!plan.sizeUnknown) return plan.start + end < size;
  return (
    plan.length > 0 && (await hasMore(file, plan.start + window.buffer.length, window.seekless))
  );
}

// Only observed evidence may claim the content ended before the offset: bytes
// served before it, or a fallback that ran and hit EOF. A zero size plus a
// fallback that ran also proves an empty seekless descriptor; a skipped
// fallback proves nothing.
function contentEndedBeforeOffset(plan: ReadPlan, window: ReadWindow) {
  if (window.eofBeforeStart === true || window.sawBytes === true) return true;
  if (!plan.sizeUnknown) return false;
  return window.seekless === true || plan.start === 0;
}

// A seekless descriptor that reached the requested offset and then read zero
// bytes ended there; the reported size may still be a placeholder.
function emptyCompletePage(plan: ReadPlan, window: ReadWindow): FilePage {
  // A seekless descriptor that reached the requested offset and then read zero
  // bytes ended there; the reported size may still be a placeholder.
  const readable = window.sawBytes === true && window.eofBeforeStart !== true;
  return {
    start: plan.requested,
    chunk: Buffer.alloc(0),
    truncated: false,
    sizeUnknown: plan.sizeUnknown,
    ...(readable ? { readableEnd: plan.start } : {}),
  };
}

// A seekless descriptor that served bytes before the requested offset simply
// ended there, even when its stat size is a padded placeholder. A known-size
// descriptor that returns nothing at a nonzero offset is a stall, not EOF.
// The sequential fallback also runs for a regular file, so an empty window is
// only EOF evidence while the descriptor's size is unchanged: a file truncated
// after stat must still ask the caller to retry, while a sysfs attribute keeps
// its padded page-sized placeholder through the same re-stat.
async function emptyWindowPage(
  file: FileHandle,
  plan: ReadPlan,
  size: number,
  window: ReadWindow,
  offset: number,
): Promise<FilePage | undefined> {
  if (window.buffer.length) return undefined;
  if (plan.sizeUnknown && window.probeSkipped) throw unprobeable(offset);
  if (contentEndedBeforeOffset(plan, window)) {
    if (!plan.sizeUnknown) {
      const current = await recheckSize(file);
      if (current !== undefined && current !== size) throw nonAdvancing(offset);
    }
    return emptyCompletePage(plan, window);
  }
  if (!plan.sizeUnknown && plan.length) throw nonAdvancing(offset);
  return undefined;
}

type WindowSlice = { start: number; chunk: Buffer; end: number; insideCharacter: boolean };

// A caller can derive a byte offset from another tool and land inside a UTF-8
// character. Start at the character's lead byte instead of silently skipping
// it; the page notes the adjustment. A continuation byte that is not part of a
// valid sequence is treated as the requested boundary so binary data still
// reads from exactly where it was asked for.
function sliceWindow(plan: ReadPlan, window: ReadWindow, maxBytes: number): WindowSlice {
  const windowLength = window.buffer.length;
  // readPage handles the known-size case where a short window stops before the
  // requested offset, so this clause is either an unknown-size clamp or an
  // already-handled page. Never skip silently: clamp to what was observed.
  const requestedIndex = Math.min(plan.requested - plan.start, windowLength);
  const requestedBoundary = characterBoundary(window.buffer, requestedIndex);
  const insideCharacter = requestedBoundary.after > requestedIndex;
  const startIndex = insideCharacter ? requestedBoundary.before : requestedIndex;
  const edge = characterBoundary(window.buffer, Math.min(startIndex + maxBytes, windowLength));
  // A page smaller than one character still has to advance.
  const end = edge.before > startIndex ? edge.before : edge.after;
  return {
    start: plan.start + startIndex,
    chunk: window.buffer.subarray(startIndex, end),
    end,
    insideCharacter,
  };
}

// A stat size of zero is normal for procfs and some FUSE files. When the
// reported size is zero, read the descriptor directly and treat the size as
// unknown instead of allocating a zero-byte window. Some sysfs attributes
// instead report a page-sized stub, so a short read before the planned window
// is treated as EOF rather than as evidence of truncation.
export async function readPage(
  file: FileHandle,
  size: number,
  offset: number,
  maxBytes: number,
): Promise<FilePage> {
  const plan = planRead(size, offset, maxBytes);
  const window = await readWindow(file, plan.start, plan.length);
  const empty = await emptyWindowPage(file, plan, size, window, offset);
  if (empty !== undefined) return empty;
  // A short window means the read hit the end of the readable content. When it
  // ends before the requested offset, a padded stat size (sysfs) must not turn
  // an offset beyond EOF into a "file changed" error; a real shrink still must,
  // because its descriptor now reports a different size.
  const readableEnd = plan.start + window.buffer.length;
  const short = await shortWindowPage(file, plan, size, window, offset);
  if (short !== undefined) return short;
  const { start, chunk, end, insideCharacter } = sliceWindow(plan, window, maxBytes);
  const truncated = await pageTruncated(file, plan, size, window, end);
  if (truncated && start + chunk.length <= plan.requested) throw nonAdvancing(offset);
  const shortEnd = !plan.sizeUnknown && window.short ? readableEnd : undefined;
  return {
    start,
    chunk,
    truncated,
    sizeUnknown: plan.sizeUnknown,
    ...(insideCharacter ? { adjustedFrom: plan.requested } : {}),
    ...(shortEnd !== undefined && shortEnd < size ? { readableEnd: shortEnd } : {}),
  };
}

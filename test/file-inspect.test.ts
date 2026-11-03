import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type FileHandle, open, truncate } from 'node:fs/promises';
import { readPage, scanDirectory } from '../src/file-inspect.ts';

function memoryFile(data: Buffer): FileHandle {
  return {
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const available = Math.max(0, Math.min(length, data.length - position));
      data.copy(buffer, offset, position, position + available);
      return { bytesRead: available, buffer };
    },
  } as unknown as FileHandle;
}

const zeroFile = {
  read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }),
} as unknown as FileHandle;

test('readPage turns a persistent zero read into a clear error instead of a stall', async () => {
  await assert.rejects(() => readPage(zeroFile, 10, 0, 4), /file changed while reading/);
  await assert.rejects(() => readPage(zeroFile, 10, 5, 4), /file changed while reading/);
});

test('readPage keeps the retry error when the file shrank under the read', async () => {
  let calls = 0;
  const shrinking = {
    read: async (buffer: Buffer, offset: number) => {
      calls += 1;
      if (calls > 1) return { bytesRead: 0, buffer };
      buffer[offset] = 0x61;
      return { bytesRead: 1, buffer };
    },
    // A real shrink changes the descriptor's size; a padded pseudo-file size
    // stays put, which is how the two cases are told apart.
    stat: async () => ({ size: 3 }),
  } as unknown as FileHandle;
  await assert.rejects(() => readPage(shrinking, 10, 5, 4), /file changed while reading/);
});

test('readPage keeps the retry error when a regular file shrank below the window start', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-inspect-'));
  const name = path.join(dir, 'shrinking');
  writeFileSync(name, Buffer.alloc(100, 0x61));
  const handle = await open(name, 'r');
  try {
    // 100 bytes as stat reported them, then truncated to 4. The window starts
    // at 47, so the read is empty and the sequential fallback sees the short
    // content end before the requested offset 50. Re-stat must still tell this
    // apart from a sysfs attribute whose padded placeholder size never moves.
    await truncate(name, 4);
    await assert.rejects(() => readPage(handle, 100, 50, 10), /file changed while reading/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A sysfs-style descriptor: a page-sized stat placeholder, no working pread at
// a nonzero offset, but a normal sequential read.
function paddedFile(data: Buffer, reportedSize: number): FileHandle {
  let position = 0;
  return {
    read: async (buffer: Buffer, offset: number, length: number, at: number | null) => {
      if (at !== null && at !== undefined && at !== 0) return { bytesRead: 0, buffer };
      const start = at === null || at === undefined ? position : 0;
      const available = Math.max(0, Math.min(length, data.length - start));
      data.copy(buffer, offset, start, start + available);
      if (at === null || at === undefined) position = start + available;
      return { bytesRead: available, buffer };
    },
    stat: async () => ({ size: reportedSize }),
  } as unknown as FileHandle;
}

test('readPage ends cleanly at offsets past a padded stat size', async () => {
  const data = Buffer.from('65536\n');
  for (const offset of [7, 8, 9]) {
    const page = await readPage(paddedFile(data, 4096), 4096, offset, 4);
    assert.equal(page.start, offset, `offset ${offset} should be reported unchanged`);
    assert.equal(page.chunk.length, 0);
    assert.equal(page.truncated, false);
  }
});

test('readPage records where readable content ended under a padded stat size', async () => {
  const page = await readPage(paddedFile(Buffer.from('65536\n'), 4096), 4096, 6, 4);
  assert.equal(page.start, 6);
  assert.equal(page.chunk.length, 0);
  assert.equal(page.truncated, false);
  assert.equal(page.readableEnd, 6);
});

test('readPage surfaces a read error instead of claiming EOF', async () => {
  const data = Buffer.from('abcdefghij');
  const failing = {
    read: async (buffer: Buffer, offset: number, length: number, at: number | null) => {
      const start = at === null || at === undefined ? 0 : at;
      if (start >= data.length) throw Object.assign(new Error('read boom'), { code: 'EIO' });
      const available = Math.max(0, Math.min(length, data.length - start));
      data.copy(buffer, offset, start, start + available);
      return { bytesRead: available, buffer };
    },
  } as unknown as FileHandle;
  await assert.rejects(() => readPage(failing, 0, 0, 6), /read boom/);
});

test('readPage treats a zero-size short read as EOF, not a probe failure', async () => {
  const page = await readPage(memoryFile(Buffer.from('abcdef')), 0, 0, 6);
  assert.equal(page.chunk.toString(), 'abcdef');
  assert.equal(page.sizeUnknown, true);
  assert.equal(page.truncated, false);
});

test('readPage reads a zero stat size directly and flags it as unknown', async () => {
  const page = await readPage(memoryFile(Buffer.from('hello')), 0, 0, 10);
  assert.equal(page.sizeUnknown, true);
  assert.equal(page.chunk.toString(), 'hello');
  assert.equal(page.truncated, false);
});

test('readPage returns an empty page at or beyond EOF without a next offset', async () => {
  const data = Buffer.from('0123456789');
  const page = await readPage(memoryFile(data), data.length, 99, 4);
  assert.equal(page.start, data.length);
  assert.equal(page.chunk.length, 0);
  assert.equal(page.truncated, false);
});

test('readPage completes a UTF-8 character that crosses the maxBytes budget', async () => {
  const data = Buffer.from('a€😀z');
  const page = await readPage(memoryFile(data), data.length, 1, 1);
  assert.equal(page.start, 1);
  assert.equal(page.chunk.toString(), '€');
  assert.equal(page.truncated, true);
  assert.ok(page.start + page.chunk.length > page.start);
});

test('readPage starts at the containing character instead of skipping it', async () => {
  const data = Buffer.from('a€bc');
  const page = await readPage(memoryFile(data), data.length, 2, 10);
  assert.equal(page.start, 1);
  assert.equal(page.chunk.toString(), '€bc');
  assert.equal(page.adjustedFrom, 2);
  assert.equal(page.truncated, false);
});

test('readPage does not report EOF for an offset inside the final character', async () => {
  const data = Buffer.from('a€');
  const page = await readPage(memoryFile(data), data.length, 3, 10);
  assert.equal(page.start, 1);
  assert.equal(page.chunk.toString(), '€');
  assert.equal(page.adjustedFrom, 3);
  assert.equal(page.truncated, false);
});

test('scanDirectory pages from an exclusive name cursor', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-scan-'));
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      writeFileSync(path.join(dir, name), '');
    }
    const scan = await scanDirectory(dir, 'b.txt', 2);
    assert.equal(scan.total, 4);
    assert.equal(scan.matches, 2);
    assert.deepEqual(
      scan.entries.map((entry) => entry.name),
      ['c.txt', 'd.txt'],
    );
    const none = await scanDirectory(dir, 'z.txt', 2);
    assert.equal(none.matches, 0);
    assert.deepEqual(none.entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDirectory keeps invalid UTF-8 sibling names reachable one page at a time', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-scan-invalid-'));
  try {
    // Both names decode to "a\uFFFD"; only the raw bytes tell them apart.
    const names = [Buffer.from([0x61, 0xfe]), Buffer.from([0x61, 0xff])];
    for (const name of names) {
      writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), name]), '');
    }
    const first = await scanDirectory(dir, undefined, 1);
    assert.equal(first.total, 2);
    assert.equal(first.matches, 2);
    assert.equal(first.entries.length, 1);
    const second = await scanDirectory(dir, first.entries[0], 1);
    assert.equal(second.matches, 1);
    assert.equal(second.entries.length, 1);
    assert.notDeepEqual(second.entries[0].raw, first.entries[0].raw);
    assert.equal(Buffer.from(second.entries[0].name, 'utf8').equals(second.entries[0].raw), false);
    const third = await scanDirectory(dir, second.entries[0], 1);
    assert.equal(third.matches, 0);
    assert.deepEqual(third.entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A descriptor that rejects every nonzero offset read but serves sequential
// reads, like procfs/sysfs attributes that do not implement pread.
function seeklessFile(data: Buffer): FileHandle {
  let position = 0;
  return {
    read: async (buffer: Buffer, offset: number, length: number, at: number | null) => {
      const start = at === null || at === undefined ? position : at;
      if (start !== 0 && start !== position) return { bytesRead: 0, buffer };
      if (at !== null && at !== undefined && at !== 0) return { bytesRead: 0, buffer };
      const available = Math.max(0, Math.min(length, data.length - start));
      data.copy(buffer, offset, start, start + available);
      if (at === null || at === undefined) position = start + available;
      return { bytesRead: available, buffer };
    },
  } as unknown as FileHandle;
}

test('readPage treats an early EOF on a known-size file as complete, not truncated', async () => {
  const page = await readPage(memoryFile(Buffer.from('65536\n')), 4096, 0, 262144);
  assert.equal(page.chunk.toString(), '65536\n');
  assert.equal(page.truncated, false);
});

test('readPage still reports truncation when maxBytes ends a page before an early EOF', async () => {
  const page = await readPage(memoryFile(Buffer.from('65536\n')), 4096, 0, 4);
  assert.equal(page.chunk.toString(), '6553');
  assert.equal(page.truncated, true);
  assert.equal(page.start + page.chunk.length, 4);
});

test('readPage recovers a nonzero offset on a descriptor that rejects offset reads', async () => {
  const data = Buffer.from('0123456789');
  const page = await readPage(seeklessFile(data), data.length, 4, 4);
  assert.equal(page.start, 4);
  assert.equal(page.chunk.toString(), '4567');
  assert.equal(page.truncated, true);
  assert.equal(page.start + page.chunk.length, 8);
});

test('readPage pages the final seekless window without a next offset', async () => {
  const data = Buffer.from('0123456789');
  const page = await readPage(seeklessFile(data), data.length, 8, 4);
  assert.equal(page.start, 8);
  assert.equal(page.chunk.toString(), '89');
  assert.equal(page.truncated, false);
});

test('readPage refuses to claim EOF when the fallback cannot probe the offset', async () => {
  // A zero stat size plus a rejected offset read is ambiguous, and the bounded
  // sequential fallback cannot reach past its cap. The zero read is not EOF
  // evidence there, so the page must fail instead of reporting completeness.
  const cap = 4 * 1024 * 1024;
  const data = Buffer.alloc(cap + 64, 0x61);
  await assert.rejects(
    () => readPage(seeklessFile(data), 0, cap, 4),
    /cannot tell whether more content follows offset/,
  );
});

test('readPage pages a zero-size seekless descriptor', async () => {
  const data = Buffer.from('abcdefgh');
  const first = await readPage(seeklessFile(data), 0, 0, 4);
  assert.equal(first.chunk.toString(), 'abcd');
  assert.equal(first.truncated, true);
  assert.equal(first.start + first.chunk.length, 4);
  const second = await readPage(seeklessFile(data), 0, 4, 4);
  assert.equal(second.start, 4);
  assert.equal(second.chunk.toString(), 'efgh');
  assert.equal(second.truncated, false);
});

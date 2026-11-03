import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { startSurfaces } from '../src/server.ts';
import {
  GATEWAY_TOKEN,
  TOKEN,
  bridgeConfig,
  call,
  mcpUrl,
  okReply,
  removeDir,
  rpc,
  send,
  startBridge,
  stubDaemon,
  tempDir,
  toolCall,
} from './helpers.ts';

const FILES_TOOL = 'taskferry_files';
const README_NAME = 'readme.txt';

async function filesFixture() {
  const daemon = await stubDaemon((req) => okReply(req, {}));
  const bridge = await startBridge(daemon.socket);
  return {
    calls: daemon.calls,
    url: bridge.url,
    close: async () => {
      await bridge.close();
      await daemon.close();
    },
  };
}

const readText = (sent: Awaited<ReturnType<typeof call>>) =>
  JSON.parse(sent.result?.content?.[0]?.text ?? '{}');

async function filesPage(
  f: Awaited<ReturnType<typeof filesFixture>>,
  args: Record<string, unknown>,
) {
  return readText(await call(f.url, toolCall(FILES_TOOL, args)));
}

async function filesError(
  f: Awaited<ReturnType<typeof filesFixture>>,
  args: Record<string, unknown>,
) {
  const sent = await call(f.url, toolCall(FILES_TOOL, args));
  assert.equal(sent.result?.isError, true);
  return sent.result?.content?.[0]?.text ?? '';
}

async function collectUtf8Pages(
  f: Awaited<ReturnType<typeof filesFixture>>,
  file: string,
  maxBytes: number,
) {
  let offset = 0;
  let text = '';
  let guard = 0;
  for (;;) {
    const page = await filesPage(f, { offset, maxBytes, path: file });
    assert.equal(page.binary, false);
    assert.ok(Buffer.byteLength(page.content) <= maxBytes + 3);
    text += page.content;
    if (!page.truncated) return text;
    assert.ok(page.nextOffset > offset, `page at ${offset} did not advance`);
    offset = page.nextOffset;
    assert.ok((guard += 1) < 20, 'UTF-8 page loop did not terminate');
  }
}

test('files still requires the bridge bearer token', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-auth-'));
  try {
    writeFileSync(path.join(outside, README_NAME), 'hello');
    const unauthenticated = await send(f.url, toolCall(FILES_TOOL, { path: outside }), {
      token: null,
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(f.calls.length, 0);

    const authorized = await call(f.url, toolCall(FILES_TOOL, { path: outside }));
    assert.notEqual(authorized.result?.isError, true);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files lists an external absolute directory with no workspace allowlist', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-external-'));
  try {
    mkdirSync(path.join(outside, 'nested'));
    writeFileSync(path.join(outside, README_NAME), 'hello');
    writeFileSync(path.join(outside, 'nested', 'deep.txt'), 'deep');

    const body = await filesPage(f, { path: outside });
    assert.equal(body.kind, 'directory');
    assert.equal(body.requested, outside);
    assert.equal(body.path, outside);
    assert.equal(body.total, 2);
    assert.equal(body.returned, 2);
    assert.equal(body.truncated, false);
    assert.equal(body.nextOffset, undefined);
    assert.deepEqual(
      body.entries.map((entry: { name: string; type: string }) => [entry.name, entry.type]),
      [
        ['nested', 'directory'],
        [README_NAME, 'file'],
      ],
    );

    const nestedBody = await filesPage(f, { path: path.join(outside, 'nested') });
    assert.equal(nestedBody.kind, 'directory');
    assert.equal(nestedBody.path, path.join(outside, 'nested'));
    assert.deepEqual(
      nestedBody.entries.map((entry: { name: string }) => entry.name),
      ['deep.txt'],
    );
    assert.equal(nestedBody.entries[0].size, Buffer.byteLength('deep'));

    assert.equal(f.calls.length, 0, 'taskferry_files must not call the daemon');
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files reads absolute nested files and pages by byte offset', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-paging-'));
  try {
    mkdirSync(path.join(outside, 'nested'));
    const file = path.join(outside, 'nested', 'ten.txt');
    writeFileSync(file, '0123456789');

    const full = await filesPage(f, { path: file });
    assert.equal(full.kind, 'file');
    assert.equal(full.path, file);
    assert.equal(full.size, 10);
    assert.equal(full.content, '0123456789');
    assert.equal(full.bytesRead, 10);
    assert.equal(full.truncated, false);
    assert.equal(full.binary, false);

    const first = await filesPage(f, { path: file, offset: 0, maxBytes: 4 });
    assert.equal(first.content, '0123');
    assert.equal(first.offset, 0);
    assert.equal(first.bytesRead, 4);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 4);

    const second = await filesPage(f, {
      path: file,
      offset: first.nextOffset,
      maxBytes: 4,
    });
    assert.equal(second.content, '4567');
    assert.equal(second.nextOffset, 8);

    const last = await filesPage(f, {
      path: file,
      offset: second.nextOffset,
      maxBytes: 4,
    });
    assert.equal(last.content, '89');
    assert.equal(last.truncated, false);
    assert.equal(last.nextOffset, undefined);

    const relative = await filesError(f, { path: 'ten.txt' });
    assert.match(relative, /must be an absolute path/);

    const missing = await filesError(f, { path: path.join(outside, 'nope.txt') });
    assert.match(missing, /path not found/);

    const notDirectory = await filesError(f, { path: `${file}${path.sep}` });
    assert.match(notDirectory, /not a directory/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files pages UTF-8 text without splitting characters', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-utf8-'));
  try {
    const expected = 'a€😀z';
    const file = path.join(outside, 'utf8.txt');
    writeFileSync(file, expected);

    for (let maxBytes = 1; maxBytes <= Buffer.byteLength(expected); maxBytes += 1) {
      const text = await collectUtf8Pages(f, file, maxBytes);
      assert.equal(text, expected, `maxBytes ${maxBytes} reconstructed text`);
    }

    const euro = await filesPage(f, { path: file, offset: 1, maxBytes: 1 });
    assert.equal(euro.content, '€');
    assert.equal(euro.bytesRead, 3);
    const emoji = await filesPage(f, { path: file, offset: 4, maxBytes: 1 });
    assert.equal(emoji.content, '😀');
    assert.equal(emoji.bytesRead, 4);

    const insideEuro = await filesPage(f, { path: file, offset: 2 });
    assert.equal(insideEuro.offset, 1);
    assert.equal(insideEuro.content, '€😀z');
    assert.match(insideEuro.note, /inside a UTF-8 character; page starts at 1/);

    const finalCharacter = path.join(outside, 'final.txt');
    writeFileSync(finalCharacter, 'a€');
    const insideFinal = await filesPage(f, { path: finalCharacter, offset: 3 });
    assert.equal(insideFinal.offset, 1);
    assert.equal(insideFinal.content, '€');
    assert.equal(insideFinal.truncated, false);
    assert.equal(insideFinal.nextOffset, undefined);
    assert.match(insideFinal.note, /inside a UTF-8 character; page starts at 1/);
    assert.doesNotMatch(insideFinal.note, /at or beyond the end/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files pages a directory listing with after and maxEntries', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-entries-'));
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      writeFileSync(path.join(outside, name), name);
    }

    const first = await filesPage(f, { path: outside, maxEntries: 2 });
    assert.equal(first.total, 5);
    assert.equal(first.returned, 2);
    assert.equal(first.truncated, true);
    assert.equal(first.nextAfter, 'b.txt');
    assert.equal(first.nextOffset, undefined);
    assert.deepEqual(
      first.entries.map((entry: { name: string }) => entry.name),
      ['a.txt', 'b.txt'],
    );

    const second = await filesPage(f, {
      path: outside,
      after: first.nextAfter,
      maxEntries: 2,
    });
    assert.equal(second.after, 'b.txt');
    assert.equal(second.truncated, true);
    assert.equal(second.nextAfter, 'd.txt');
    assert.deepEqual(
      second.entries.map((entry: { name: string }) => entry.name),
      ['c.txt', 'd.txt'],
    );

    const last = await filesPage(f, { path: outside, after: second.nextAfter, maxEntries: 2 });
    assert.equal(last.truncated, false);
    assert.equal(last.nextAfter, undefined);
    assert.deepEqual(
      last.entries.map((entry: { name: string }) => entry.name),
      ['e.txt'],
    );

    const beyond = await filesPage(f, { path: outside, after: 'z.txt' });
    assert.deepEqual(beyond.entries, []);
    assert.equal(beyond.returned, 0);
    assert.equal(beyond.truncated, false);
    assert.match(beyond.note, /no entries after "z.txt"/);

    const offsetDenied = await filesError(f, { path: outside, offset: 1 });
    assert.match(offsetDenied, /offset applies to file reads only/);

    const noted = await filesPage(f, { path: outside, maxBytes: 4 });
    assert.match(noted.note, /file reads only/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files pages invalid UTF-8 entry names without skipping siblings', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-invalid-'));
  try {
    // Both names decode to "a\uFFFD", so a plain name cursor cannot tell them apart.
    const rawNames = [Buffer.from([0x61, 0xfe]), Buffer.from([0x61, 0xff])];
    for (const [index, raw] of rawNames.entries()) {
      writeFileSync(Buffer.concat([Buffer.from(`${outside}${path.sep}`), raw]), `v${index}`);
    }

    const first = await filesPage(f, { path: outside, maxEntries: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.returned, 1);
    assert.equal(first.truncated, true);
    assert.equal(first.nextAfter, undefined);
    assert.equal(typeof first.nextAfterBase64, 'string');
    assert.equal(typeof first.entries[0].nameBase64, 'string');
    assert.match(first.note, /not valid UTF-8; continue with nextAfterBase64/);

    const second = await filesPage(f, {
      path: outside,
      afterBase64: first.nextAfterBase64,
      maxEntries: 1,
    });
    assert.equal(second.returned, 1);
    assert.equal(second.truncated, false);
    assert.equal(second.nextAfterBase64, undefined);
    assert.notEqual(second.entries[0].nameBase64, first.entries[0].nameBase64);

    const seen = [first.entries[0].nameBase64, second.entries[0].nameBase64]
      .map((value: string) => Buffer.from(value, 'base64'))
      .map((value) => value.toString('hex'))
      .sort();
    assert.deepEqual(seen, rawNames.map((value) => value.toString('hex')).sort());

    const both = await filesError(f, { path: outside, after: 'a', afterBase64: 'YQ==' });
    assert.match(both, /mutually exclusive/);
    const malformed = await filesError(f, { path: outside, afterBase64: 'not base64!' });
    assert.match(malformed, /standard base64/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files reads a pending overlay upperDir without applying it', async () => {
  const f = await filesFixture();
  const workspace = realpathSync(tempDir('tf-files-overlay-ws-'));
  const upper = realpathSync(tempDir('tf-files-overlay-upper-'));
  try {
    writeFileSync(path.join(workspace, 'app.txt'), 'COMMITTED CONTENT');
    writeFileSync(path.join(upper, 'app.txt'), 'PENDING CHANGESET CONTENT');

    const listing = await filesPage(f, { path: upper });
    assert.deepEqual(
      listing.entries.map((entry: { name: string }) => entry.name),
      ['app.txt'],
    );
    const pending = await filesPage(f, { path: path.join(upper, 'app.txt') });
    assert.equal(pending.content, 'PENDING CHANGESET CONTENT');
    assert.equal(readFileSync(path.join(workspace, 'app.txt'), 'utf8'), 'COMMITTED CONTENT');
    assert.equal(f.calls.length, 0, 'reading an overlay must not call the daemon');
  } finally {
    await f.close();
    removeDir(workspace);
    removeDir(upper);
  }
});

test('files sorts and pages a large directory in exact name order', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-large-'));
  try {
    const names = Array.from({ length: 1200 }, (_, i) => `entry-${String(i).padStart(4, '0')}.txt`);
    for (const name of names) writeFileSync(path.join(outside, name), '');

    const listed: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await filesPage(f, { path: outside, ...(after === undefined ? {} : { after }) });
      assert.equal(page.total, names.length);
      listed.push(...page.entries.map((entry: { name: string }) => entry.name));
      if (!page.truncated) break;
      assert.equal(typeof page.nextAfter, 'string');
      if (after !== undefined) assert.ok(page.nextAfter > after);
      after = page.nextAfter;
    }
    assert.deepEqual(listed, names);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test(
  'files reaches the tail of a directory with more than 100000 entries',
  { timeout: 60_000 },
  async () => {
    const f = await filesFixture();
    const outside = realpathSync(tempDir('tf-files-tail-'));
    try {
      const count = 100_050;
      const name = (i: number) => `entry-${String(i).padStart(6, '0')}.txt`;
      for (let i = 0; i < count; i += 1) writeFileSync(path.join(outside, name(i)), '');

      const middle = await filesPage(f, {
        path: outside,
        after: name(50_000),
        maxEntries: 100,
      });
      assert.equal(middle.total, count);
      assert.equal(middle.returned, 100);
      assert.equal(middle.truncated, true);
      assert.equal(middle.nextAfter, name(50_100));
      assert.deepEqual(
        middle.entries.map((entry: { name: string }) => entry.name),
        Array.from({ length: 100 }, (_, i) => name(50_001 + i)),
      );

      const listing = await filesPage(f, {
        path: outside,
        after: name(99_999),
        maxEntries: 100,
      });
      assert.equal(listing.total, count);
      assert.equal(listing.returned, 50);
      assert.equal(listing.truncated, false);
      assert.equal(listing.nextAfter, undefined);
      assert.deepEqual(
        listing.entries.map((entry: { name: string }) => entry.name),
        Array.from({ length: 50 }, (_, i) => name(100_000 + i)),
      );
    } finally {
      await f.close();
      removeDir(outside);
    }
  },
);

test('files states an empty directory', async () => {
  const f = await filesFixture();
  const empty = realpathSync(tempDir('tf-files-empty-'));
  try {
    const listed = await filesPage(f, { path: empty });
    assert.deepEqual(listed.entries, []);
    assert.equal(listed.total, 0);
    assert.equal(listed.returned, 0);
    assert.equal(listed.truncated, false);
    assert.match(listed.note, /directory is empty/);
  } finally {
    await f.close();
    removeDir(empty);
  }
});

test(
  'files follows symlinks, reports loops, and handles non-regular files',
  { timeout: 15_000 },
  async () => {
    const f = await filesFixture();
    const outside = realpathSync(tempDir('tf-files-links-'));
    try {
      const target = path.join(outside, 'target.txt');
      writeFileSync(target, 'linked content');
      symlinkSync(target, path.join(outside, 'link.txt'));
      symlinkSync(path.join(outside, 'missing.txt'), path.join(outside, 'broken.txt'));
      symlinkSync('loop.txt', path.join(outside, 'loop.txt'));

      const linked = await filesPage(f, { path: path.join(outside, 'link.txt') });
      assert.equal(linked.content, 'linked content');
      assert.equal(linked.path, target);

      const listed = await filesPage(f, { path: outside });
      assert.ok(
        listed.entries.some(
          (entry: { name: string; type: string }) =>
            entry.name === 'link.txt' && entry.type === 'symlink',
        ),
      );

      const broken = await filesError(f, { path: path.join(outside, 'broken.txt') });
      assert.match(broken, /path not found/);

      const loop = await filesError(f, { path: path.join(outside, 'loop.txt') });
      assert.match(loop, /symlink loop/);

      if (existsSync('/dev/null')) {
        const device = await filesPage(f, { path: '/dev/null' });
        assert.equal(device.kind, 'other');
        assert.equal(device.content, null);
        assert.match(device.note, /not a regular file/);
      }

      const fifo = path.join(outside, 'pipe');
      const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(existsSync);
      if (mkfifo) {
        try {
          execFileSync(mkfifo, [fifo]);
        } catch {
          // The /dev/null check above still covers non-regular files.
        }
      }
      if (existsSync(fifo)) {
        const pipe = await filesPage(f, { path: fifo });
        assert.equal(pipe.kind, 'other');
        assert.equal(pipe.content, null);
      }
    } finally {
      await f.close();
      removeDir(outside);
    }
  },
);

test('files reports OS permission errors without leaking contents', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root bypasses file mode bits');
    return;
  }
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-perm-'));
  const secret = path.join(outside, 'secret.txt');
  const locked = path.join(outside, 'locked');
  try {
    writeFileSync(secret, 'TOP_SECRET_CONTENT');
    chmodSync(secret, 0o000);
    const denied = await filesError(f, { path: secret });
    assert.match(denied, /permission denied/);
    assert.doesNotMatch(denied, /TOP_SECRET_CONTENT/);
    chmodSync(secret, 0o600);

    mkdirSync(locked);
    writeFileSync(path.join(locked, 'inside.txt'), 'inside');
    chmodSync(locked, 0o000);
    const deniedDir = await filesError(f, { path: locked });
    assert.match(deniedDir, /permission denied/);
  } finally {
    chmodSync(secret, 0o600);
    try {
      chmodSync(locked, 0o700);
    } catch {
      // The directory may not have been created if the test failed early.
    }
    await f.close();
    removeDir(outside);
  }
});

test('files pages past the old 10 MB offset cap to EOF', { timeout: 30_000 }, async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-large-offset-'));
  try {
    const size = 12 * 1024 * 1024;
    const file = path.join(outside, 'large.bin');
    writeFileSync(file, '');
    truncateSync(file, size);

    const capped = await filesPage(f, {
      path: file,
      offset: 10_000_000,
      maxBytes: 1024 * 1024,
    });
    assert.equal(capped.offset, 10_000_000);
    assert.equal(capped.bytesRead, 1024 * 1024);
    assert.equal(capped.truncated, true);
    assert.equal(capped.nextOffset, 11_048_576);

    let offset = 0;
    let total = 0;
    let lastEnd = 0;
    let guard = 0;
    for (;;) {
      const page = await filesPage(f, { offset, path: file, maxBytes: 1024 * 1024 });
      assert.equal(page.offset, offset);
      assert.ok(page.bytesRead > 0, `page at ${offset} returned no bytes`);
      total += page.bytesRead;
      lastEnd = page.offset + page.bytesRead;
      if (!page.truncated) break;
      assert.ok(page.nextOffset > offset, `page at ${offset} did not advance`);
      offset = page.nextOffset;
      assert.ok((guard += 1) < 20, 'large file page loop did not terminate');
    }
    assert.equal(total, size);
    assert.equal(lastEnd, size);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files reads a zero-size procfs file directly', async (t) => {
  const f = await filesFixture();
  try {
    if (!existsSync('/proc/self/status')) {
      t.skip('procfs is unavailable');
      return;
    }
    const body = await filesPage(f, { path: '/proc/self/status' });
    assert.equal(body.kind, 'file');
    assert.equal(body.size, 0);
    assert.equal(body.sizeUnknown, true);
    assert.ok(body.bytesRead > 0);
    assert.equal(body.binary, false);
    assert.match(body.content, /Name:/);
    assert.match(body.note, /reported size is 0/);
    assert.equal(body.truncated, false);
  } finally {
    await f.close();
  }
});

test('files states an empty file and an offset at or beyond EOF', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-eof-'));
  try {
    const emptyFile = path.join(outside, 'empty.txt');
    writeFileSync(emptyFile, '');
    const empty = await filesPage(f, { path: emptyFile });
    assert.equal(empty.kind, 'file');
    assert.equal(empty.size, 0);
    assert.equal(empty.bytesRead, 0);
    assert.equal(empty.truncated, false);
    assert.equal(empty.content, '');
    assert.equal(empty.sizeUnknown, undefined);
    assert.match(empty.note, /file is empty/);

    const text = path.join(outside, 'five.txt');
    writeFileSync(text, 'hello');
    const atEnd = await filesPage(f, { path: text, offset: 5 });
    assert.equal(atEnd.offset, 5);
    assert.equal(atEnd.bytesRead, 0);
    assert.equal(atEnd.truncated, false);
    assert.equal(atEnd.content, '');
    assert.match(atEnd.note, /at or beyond the end/);

    const past = await filesPage(f, { path: text, offset: 99 });
    assert.equal(past.bytesRead, 0);
    assert.equal(past.truncated, false);
    assert.match(past.note, /at or beyond the end/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files flags binary pages and detects them per page', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-binary-'));
  try {
    const binary = path.join(outside, 'binary.bin');
    writeFileSync(binary, Buffer.from([0x61, 0x62, 0x63, 0x00, 0x64]));
    const page = await filesPage(f, { path: binary });
    assert.equal(page.binary, true);
    assert.equal(page.content, null);
    assert.match(page.note, /binary page/);

    const late = path.join(outside, 'late-nul.bin');
    writeFileSync(late, Buffer.concat([Buffer.alloc(300_000, 0x61), Buffer.from([0])]));
    const first = await filesPage(f, { path: late, maxBytes: 1024 });
    assert.equal(first.binary, false);
    assert.equal(first.bytesRead, 1024);
    assert.equal(typeof first.content, 'string');
    const last = await filesPage(f, { path: late, offset: 300_000, maxBytes: 1024 });
    assert.equal(last.binary, true);
    assert.equal(last.content, null);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files applies the default 256 KiB file page budget', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-default-bytes-'));
  try {
    const file = path.join(outside, 'big.txt');
    writeFileSync(file, 'a'.repeat(300 * 1024));
    const page = await filesPage(f, { path: file });
    assert.equal(page.bytesRead, 256 * 1024);
    assert.equal(page.truncated, true);
    assert.equal(page.nextOffset, 256 * 1024);
    assert.equal(page.content.length, 256 * 1024);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files is exposed on both authenticated surfaces and each enforces its token', async () => {
  const daemon = await stubDaemon((req) => okReply(req, {}));
  const surfaces = await startSurfaces(
    bridgeConfig({
      daemonSocket: daemon.socket,
      listen: { kind: 'tcp', port: 0 },
      gateway: { token: GATEWAY_TOKEN, port: 0 },
    }),
  );
  const outside = realpathSync(tempDir('tf-files-gateway-'));
  try {
    const gateway = surfaces.gateway;
    assert.ok(gateway);
    const bridgeUrl = mcpUrl(surfaces.bridge);
    const gatewayUrl = mcpUrl(gateway);
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'BOTH_SURFACES_READ');
    const bridgeTokenFile = path.join(outside, 'bridge-token');
    writeFileSync(bridgeTokenFile, TOKEN);
    chmodSync(bridgeTokenFile, 0o600);

    const bridgeTools = (await call(bridgeUrl, rpc('tools/list'))).result?.tools ?? [];
    assert.ok(bridgeTools.some((tool) => tool.name === FILES_TOOL));
    const gatewayTools =
      (await call(gatewayUrl, rpc('tools/list'), { token: GATEWAY_TOKEN })).result?.tools ?? [];
    assert.ok(gatewayTools.some((tool) => tool.name === FILES_TOOL));

    const readThrough = async (url: string, token: string, file: string) => {
      const sent = await call(url, toolCall(FILES_TOOL, { path: file }), { token });
      assert.notEqual(sent.result?.isError, true);
      return readText(sent);
    };

    assert.equal((await readThrough(bridgeUrl, TOKEN, secret)).content, 'BOTH_SURFACES_READ');
    assert.equal(
      (await readThrough(gatewayUrl, GATEWAY_TOKEN, secret)).content,
      'BOTH_SURFACES_READ',
    );

    // Documented consequence: the gateway token is host-read authority, so it
    // can read a bridge token file the service user can read.
    assert.equal((await readThrough(gatewayUrl, GATEWAY_TOKEN, bridgeTokenFile)).content, TOKEN);

    const gatewayUnauthenticated = await send(gatewayUrl, toolCall(FILES_TOOL, { path: secret }), {
      token: null,
    });
    assert.equal(gatewayUnauthenticated.status, 401);
    const bridgeUnauthenticated = await send(bridgeUrl, toolCall(FILES_TOOL, { path: secret }), {
      token: null,
    });
    assert.equal(bridgeUnauthenticated.status, 401);

    const bridgeWithGatewayToken = await send(bridgeUrl, toolCall(FILES_TOOL, { path: secret }), {
      token: GATEWAY_TOKEN,
    });
    assert.equal(bridgeWithGatewayToken.status, 401);
    const gatewayWithBridgeToken = await send(gatewayUrl, toolCall(FILES_TOOL, { path: secret }), {
      token: TOKEN,
    });
    assert.equal(gatewayWithBridgeToken.status, 401);
    assert.equal(daemon.calls.length, 0, 'taskferry_files must not call the daemon');
  } finally {
    await surfaces.close();
    await daemon.close();
    removeDir(outside);
  }
});

test('files treats a sysfs attribute with a padded stat size as complete', async (t) => {
  const sysfs = '/sys/class/net/lo/mtu';
  if (!existsSync(sysfs)) {
    t.skip('sysfs attribute is unavailable');
    return;
  }
  const f = await filesFixture();
  try {
    const expected = readFileSync(sysfs, 'utf8');
    const body = await filesPage(f, { path: sysfs });
    assert.equal(body.kind, 'file');
    assert.equal(body.content, expected);
    assert.equal(body.bytesRead, Buffer.byteLength(expected));
    assert.equal(body.truncated, false);
    assert.equal(body.nextOffset, undefined);
    assert.ok(body.size > Buffer.byteLength(expected), 'sysfs stat size is padded');
    // Offsets past the readable content but under the padded stat size are EOF,
    // not the retry error a shrinking regular file would produce.
    const length = Buffer.byteLength(expected);
    for (const offset of [length + 1, length + 2, length + 3]) {
      const past = await filesPage(f, { offset, maxBytes: 4, path: sysfs });
      assert.equal(past.kind, 'file');
      assert.equal(past.bytesRead, 0);
      assert.equal(past.truncated, false);
      assert.equal(past.content, '');
      assert.match(past.note, /end of readable content/);
    }
  } finally {
    await f.close();
  }
});

test('files pages a seekless procfs entry with a small maxBytes', async (t) => {
  const uptime = '/proc/uptime';
  if (!existsSync(uptime)) {
    t.skip('procfs is unavailable');
    return;
  }
  const f = await filesFixture();
  try {
    let offset = 0;
    let pages = 0;
    let text = '';
    for (;;) {
      const body = await filesPage(f, { offset, path: uptime, maxBytes: 4 });
      assert.equal(body.kind, 'file');
      assert.ok(body.bytesRead > 0, `page at ${offset} returned no bytes`);
      text += body.content;
      pages += 1;
      if (!body.truncated) break;
      assert.ok(body.nextOffset > offset, `page at ${offset} did not advance`);
      offset = body.nextOffset;
      assert.ok(pages < 12, 'seekless page loop did not terminate');
    }
    assert.ok(pages > 1, 'the entry needed more than one page');
    assert.match(text, /^\d/);
  } finally {
    await f.close();
  }
});

test('files addresses paths that are not valid UTF-8 with pathBase64', async () => {
  const f = await filesFixture();
  const outside = realpathSync(tempDir('tf-files-raw-path-'));
  try {
    const rawFile = Buffer.from([0x61, 0xfe]);
    const file = Buffer.concat([Buffer.from(`${outside}/`), rawFile]);
    writeFileSync(file, 'raw-name');

    const listing = await filesPage(f, { path: outside });
    const entry = listing.entries.find(
      (item: { nameBase64?: string }) => item.nameBase64 === rawFile.toString('base64'),
    );
    assert.ok(entry, 'the invalid name is listed with nameBase64');
    assert.equal(entry.name, 'a\uFFFD');

    const page = await filesPage(f, { pathBase64: file.toString('base64') });
    assert.equal(page.kind, 'file');
    assert.equal(page.content, 'raw-name');
    assert.equal(page.binary, false);

    const rawDir = Buffer.from([0x62, 0xfe]);
    const dir = Buffer.concat([Buffer.from(`${outside}/`), rawDir]);
    mkdirSync(dir);
    writeFileSync(Buffer.concat([dir, Buffer.from('/inner.txt')]), 'inner');
    const dirListing = await filesPage(f, { pathBase64: dir.toString('base64') });
    assert.equal(dirListing.kind, 'directory');
    assert.deepEqual(
      dirListing.entries.map((item: { name: string }) => item.name),
      ['inner.txt'],
    );

    const both = await filesError(f, {
      path: outside,
      pathBase64: Buffer.from(outside).toString('base64'),
    });
    assert.match(both, /mutually exclusive/);

    const neither = await filesError(f, {});
    assert.match(neither, /provide path or pathBase64/);
  } finally {
    await f.close();
    removeDir(outside);
  }
});

test('files reports a magic fd pointing at a socket or pipe as other', async (t) => {
  const fdOne = '/proc/self/fd/1';
  if (!existsSync(fdOne)) {
    t.skip('procfs file descriptors are unavailable');
    return;
  }
  let direct;
  try {
    direct = statSync(fdOne);
  } catch {
    t.skip('the standard output descriptor cannot be inspected');
    return;
  }
  if (direct.isFile() || direct.isDirectory()) {
    t.skip('standard output is a regular file in this environment');
    return;
  }
  const f = await filesFixture();
  try {
    const body = await filesPage(f, { path: fdOne });
    assert.equal(body.kind, 'other');
    assert.match(body.note, /not a regular file or directory/);
  } finally {
    await f.close();
  }
});

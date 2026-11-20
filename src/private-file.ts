import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Atomically replaces `file` with `body`: parent directory 0700, file 0600, fsync before the
// rename so a crash leaves either the old file or the new one. State files that hold secrets
// (webhook signing secrets, OAuth refresh-token hashes) are written only through this.
export function writePrivate(file: string, body: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may already have been renamed or never created; the original error matters.
    }
    throw error;
  }
}

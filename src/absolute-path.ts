import { type PathLike } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './errors.ts';

export const DENIED_ABSOLUTE = 'path denied: must be an absolute path';
export const DENIED_INVALID = 'path denied: invalid path (NUL byte)';
export const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RequestedPath = { display: string; raw?: Buffer };

export function pathError(requested: string, error: unknown) {
  const code = errorCode(error);
  switch (code) {
    case 'ENOENT':
      return new Error(
        `path not found: ${requested}; check the path and that the service user can access it`,
        { cause: error },
      );
    case 'EACCES':
    case 'EPERM':
      return new Error(`permission denied: ${requested}; the service user cannot read it`, {
        cause: error,
      });
    case 'ELOOP':
      return new Error(`symlink loop: ${requested}; resolve the link target`, { cause: error });
    case 'ENOTDIR':
      return new Error(
        `not a directory: ${requested}; pass a directory to list or a regular file to read`,
        { cause: error },
      );
    default: {
      const suffix = code ? ` (${code})` : '';
      return new Error(
        `path unavailable: ${requested}${suffix}; check the path and the service user's access`,
        { cause: error },
      );
    }
  }
}

function decodePathBase64(value: string) {
  if (value.length === 0 || !STANDARD_BASE64.test(value)) {
    throw new Error('pathBase64 must be non-empty standard base64');
  }
  return Buffer.from(value, 'base64');
}

// `path` is the readable form; `pathBase64` carries the exact bytes so a name
// that is not valid UTF-8 stays addressable instead of only listable.
export function requestedPath(args: { path?: string; pathBase64?: string }): RequestedPath {
  if (args.path !== undefined && args.pathBase64 !== undefined) {
    throw new Error('path and pathBase64 are mutually exclusive');
  }
  if (args.pathBase64 !== undefined) {
    const raw = decodePathBase64(args.pathBase64);
    return { display: raw.toString('utf8'), raw };
  }
  if (args.path === undefined) throw new Error('provide path or pathBase64');
  return { display: args.path };
}

export function targetText(target: PathLike) {
  return typeof target === 'string' ? target : target.toString('utf8');
}

export function assertAbsolute(display: string, raw: Buffer | undefined) {
  if (raw !== undefined) {
    if (raw.includes(0)) throw new Error(DENIED_INVALID);
    if (raw[0] !== 0x2f) throw new Error(DENIED_ABSOLUTE);
  } else {
    if (display.includes('\0')) throw new Error(DENIED_INVALID);
    if (!path.isAbsolute(display)) throw new Error(DENIED_ABSOLUTE);
  }
}

// There is no allowlist here: the authenticated caller may inspect any
// absolute path, and the service user's filesystem permissions are the
// boundary. Resolving symlinks first makes a dangling or looping link a plain
// error instead of a surprising target.
export async function resolvePath(display: string, raw: Buffer | undefined) {
  assertAbsolute(display, raw);
  try {
    return raw === undefined
      ? await realpath(display)
      : await realpath(raw, { encoding: 'buffer' });
  } catch (error) {
    throw pathError(display, error);
  }
}

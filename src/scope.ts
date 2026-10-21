import { realpathSync } from 'node:fs';
import path from 'node:path';

// True when `candidate` resolves, symlinks followed, to `root` or something under it. A path
// that does not exist is outside every root.
function isUnder(root: string, candidate: string) {
  try {
    const r = realpathSync(root),
      d = realpathSync(candidate);
    return d === r || d.startsWith(r + path.sep);
  } catch {
    return false;
  }
}

export const inAllowedRoot = (roots: readonly string[], dir: string) =>
  roots.some((root) => isUnder(root, dir));

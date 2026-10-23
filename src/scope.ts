import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return undefined;
      }
    }),
  );
  return resolved.filter((root): root is string => root !== undefined);
}

export async function inResolvedRoot(roots: readonly string[], dir: string) {
  let candidate: string;
  try {
    candidate = await realpath(dir);
  } catch {
    return false;
  }
  return roots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return candidate === root || candidate.startsWith(prefix);
  });
}

export async function inAllowedRoot(roots: readonly string[], dir: string) {
  return inResolvedRoot(await resolveRoots(roots), dir);
}

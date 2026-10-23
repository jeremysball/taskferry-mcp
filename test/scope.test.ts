import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { inAllowedRoot } from '../src/scope.ts';
import { tempDir, removeDir } from './helpers.ts';

test('filesystem root contains descendants without accepting sibling prefixes', async () => {
  const dir = tempDir('tf-scope-');
  try {
    const root = path.join(dir, 'root');
    const sibling = path.join(dir, 'rootfoo');
    mkdirSync(root);
    mkdirSync(sibling);
    assert.equal(await inAllowedRoot(['/'], dir), true);
    assert.equal(await inAllowedRoot([root], sibling), false);
  } finally {
    removeDir(dir);
  }
});

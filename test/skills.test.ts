import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SKILL_PROFILES, defaultSkillRoot, isSkillProfile, skillBindPaths } from '../src/skills.ts';

test('each skill profile maps to its explicit literal roots', () => {
  const root = 'test-root';
  assert.deepEqual(skillBindPaths('none', root), []);
  assert.deepEqual(skillBindPaths('worker', root), [
    path.join(root, 'skills/searching-the-web'),
    path.join(root, 'skills/using-chhoto'),
  ]);
  assert.deepEqual(skillBindPaths('controller', root), [
    path.join(root, 'skills'),
    path.join(root, 'fleet-skills'),
    path.join(root, 'plugins/cache'),
  ]);
});

test('the default skill root is ~/.claude under the supplied home', () => {
  assert.equal(defaultSkillRoot('test-home'), path.join('test-home', '.claude'));
});

test('only the known profiles are accepted', () => {
  for (const profile of SKILL_PROFILES) assert.equal(isSkillProfile(profile), true);
  for (const value of ['admin', '', undefined, null, 7, {}]) {
    assert.equal(isSkillProfile(value), false, JSON.stringify(value));
  }
});

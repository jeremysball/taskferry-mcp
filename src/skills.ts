import { homedir } from 'node:os';
import path from 'node:path';

export const SKILL_PROFILES = ['none', 'worker', 'controller'] as const;
export type SkillProfile = (typeof SKILL_PROFILES)[number];

// A Record keeps adding a profile a compile error until it gets an explicit root list, instead of
// letting a new name fall through to the controller set.
const PROFILE_ROOTS: Record<SkillProfile, readonly string[]> = {
  none: [],
  worker: ['skills/searching-the-web', 'skills/using-chhoto'],
  controller: ['skills', 'fleet-skills', 'plugins/cache'],
};

export function isSkillProfile(value: unknown): value is SkillProfile {
  return typeof value === 'string' && (SKILL_PROFILES as readonly string[]).includes(value);
}

export function defaultSkillRoot(home = homedir()): string {
  return path.join(home, '.claude');
}

export function skillBindPaths(profile: SkillProfile, skillRoot = defaultSkillRoot()): string[] {
  return PROFILE_ROOTS[profile].map((root) => path.join(skillRoot, root));
}

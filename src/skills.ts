import { homedir } from 'node:os';
import path from 'node:path';

export const SKILL_PROFILES = ['worker', 'controller'] as const;
export type SkillProfile = (typeof SKILL_PROFILES)[number];

const WORKER_SKILLS = ['searching-the-web', 'using-chhoto'] as const;
const CONTROLLER_ROOTS = ['skills', 'fleet-skills', 'plugins/cache'] as const;

export function isSkillProfile(value: unknown): value is SkillProfile {
  return typeof value === 'string' && (SKILL_PROFILES as readonly string[]).includes(value);
}

export function skillBindPaths(profile: SkillProfile, home = homedir()): string[] {
  const roots =
    profile === 'worker'
      ? WORKER_SKILLS.map((name) => path.join('skills', name))
      : CONTROLLER_ROOTS;
  return roots.map((root) => path.join(home, '.claude', root));
}

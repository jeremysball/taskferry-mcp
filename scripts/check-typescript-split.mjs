// Mechanical check for the belief behind the TypeScript split:
//   eslint runs on `typescript` (6.x) because the installed typescript-eslint
//   rejects TypeScript 7, while `tsc` runs from the `typescript-native` alias.
// Fails, naming the belief, when either half stops being true. Offline: it
// reads the installed manifests only.
import { readFileSync } from 'node:fs';
import semver from 'semver';

function manifest(name) {
  const url = new URL(`../node_modules/${name}/package.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const eslintPlugin = manifest('typescript-eslint');
const range = eslintPlugin.peerDependencies.typescript;
const forEslint = manifest('typescript').version;
const forTsc = manifest('typescript-native').version;

const problems = [];

if (!semver.satisfies(forEslint, range)) {
  problems.push(
    `typescript ${forEslint} is outside typescript-eslint ${eslintPlugin.version}'s peer range "${range}", so eslint runs on an unsupported compiler.`,
  );
}

if (semver.satisfies(forTsc, range)) {
  problems.push(
    `typescript-eslint ${eslintPlugin.version} now accepts TypeScript ${forTsc} (peer range "${range}"). ` +
      'The split is no longer needed: drop the typescript-native alias, set typescript to ' +
      `${forTsc}, and point the typecheck script back at plain tsc.`,
  );
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

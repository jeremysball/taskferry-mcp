import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// Node ESM project in TypeScript, run directly by Node's native type
// stripping (no build step). Everything runs under Node, so one
// language-options block covers the whole tree. Mirrors taskferry's
// eslint.config.mjs: recommended rules plus hard maintainability caps and the
// SonarJS bug/smell detectors, with typescript-eslint added for .ts sources.
export default defineConfig([
  { ignores: ['node_modules/**', '.worktrees/**', 'docs/evidence/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { caughtErrors: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Flag files and functions that have grown hard to hold in one pass.
  {
    files: ['**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },

  {
    files: ['**/*.ts'],
    plugins: { sonarjs },
    rules: {
      ...Object.fromEntries(
        Object.entries(sonarjs.configs.recommended.rules).map(([name, value]) => [
          name,
          Array.isArray(value) ? ['error', ...value.slice(1)] : 'error',
        ]),
      ),
      // Style preference (parens around single-arg arrows), not a bug signal.
      'sonarjs/arrow-function-convention': 'off',
      // Wants a license header block on every file; this project has none.
      'sonarjs/file-header': 'off',
    },
  },

  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
]);

import js from '@eslint/js'
import globals from 'globals'

/**
 * Lint for `scripts/` — the installer, the Lite backup tool, the deploy
 * helpers and their tests.
 *
 * This directory was unlinted, and it is not a harmless gap: `install.mjs`
 * shipped a reference to an `adminUsername` that was never declared, so the CLI
 * installer threw `ReferenceError` immediately after a successful
 * `docker compose up` — the stack was running, the operator saw a crash, and
 * the make-yourself-owner instructions never printed. `node --check` cannot see
 * that (the file parses fine); `no-undef` catches it in milliseconds.
 *
 * Deliberately narrow: correctness rules only, no style. These files are plain
 * dependency-free ESM by design — the installer has to run against a fresh
 * clone before `npm install` — so the config stays as small as the code it
 * guards.
 */
export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The rule this config exists for.
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // These are CLIs; printing is the job.
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The live harnesses ship whole functions into the page through
    // `page.evaluate`, so `document`, `location` and `localStorage` are real
    // there — they run in Chromium, not in Node.
    // `**/` prefix: with `--config scripts/eslint.config.js` ESLint resolves
    // `files` against the CWD (the repo root), not against the config's own
    // directory, so a bare `e2e-live/**` would silently match nothing.
    files: ['**/e2e-live/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
]

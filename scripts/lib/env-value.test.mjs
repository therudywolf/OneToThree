/**
 * Tests for scripts/lib/env-value.sh — the shared `.env.prod` value reader.
 *
 * The mobile build scripts bake these values into the app as `NEXT_PUBLIC_*`,
 * where a wrong value cannot fail: the APK builds, installs, and every request
 * goes to a URL that never resolves. The naive reader they used to carry kept
 * everything after the first `=`, and `config/env/.env.prod.example` documents
 * its keys with inline `#` comments — so the comment travelled into the app.
 *
 * `node --test` runs the REAL shell function against fixture files, the same
 * way scripts/lib/build-stamp.test.mjs exercises the deploy script.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = dirname(LIB)
const HELPER = join(LIB, 'env-value.sh').replace(/\\/g, '/')

/** Run `env_value KEY` against an env file with the given contents. */
function envValue(key, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'env-value-'))
  const file = join(dir, '.env.prod').replace(/\\/g, '/')
  writeFileSync(file, contents)
  try {
    const r = spawnSync('bash', ['-c', `source "${HELPER}"; env_value "${key}" "${file}"`], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('env_value', () => {
  test('reads a plain value', () => {
    assert.equal(envValue('NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_API_URL=https://api.example.com\n'), 'https://api.example.com')
  })

  /**
   * The bug: `.env.prod.example` documents keys with trailing comments, and the
   * old reader kept them — the APK shipped with an API origin of
   * "https://api.example.com   # auto-filled from the domain".
   */
  test('drops an inline comment and the space before it', () => {
    assert.equal(
      envValue('NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_API_URL=https://api.example.com   # auto-filled from the domain\n'),
      'https://api.example.com'
    )
  })

  test('drops surrounding quotes without eating a # inside them', () => {
    assert.equal(envValue('K', 'K="https://api.example.com/#/app"\n'), 'https://api.example.com/#/app')
    assert.equal(envValue('K', "K='p@ss#word'\n"), 'p@ss#word')
  })

  test('keeps a value that legitimately contains =', () => {
    assert.equal(envValue('K', 'K=abc=def==\n'), 'abc=def==')
  })

  test('survives CRLF, which a Windows-edited .env.prod is full of', () => {
    assert.equal(envValue('K', 'K=https://a.example.com\r\nJ=x\r\n'), 'https://a.example.com')
  })

  test('trims surrounding whitespace', () => {
    assert.equal(envValue('K', 'K=   https://a.example.com   \n'), 'https://a.example.com')
  })

  test('a missing key is empty, not an error', () => {
    assert.equal(envValue('NOPE', 'K=v\n'), '')
  })

  test('a commented-out key is not read as if it were set', () => {
    assert.equal(envValue('K', '#K=https://leaked.example.com\n'), '')
  })

  test('the last definition wins, like the shell reading the file', () => {
    assert.equal(envValue('K', 'K=first\nK=second\n'), 'second')
  })

  test('a key that is a prefix of another is not confused for it', () => {
    assert.equal(envValue('K', 'KK=wrong\nK=right\n'), 'right')
  })
})

describe('the build scripts use the shared reader', () => {
  /** Two copies of this logic is how they drifted apart in the first place. */
  for (const script of ['build-apk.sh', 'build-ipa.sh']) {
    test(`${script} sources env-value.sh instead of rolling its own`, () => {
      const text = readFileSync(join(SCRIPTS, script), 'utf8')
      assert.match(text, /source .*lib\/env-value\.sh/, `${script} does not source the shared reader`)
      assert.doesNotMatch(
        text,
        /val_for_key\(\)\s*\{[^}]*cut -d/,
        `${script} still carries its own cut-based reader`
      )
    })
  }
})

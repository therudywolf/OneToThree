/**
 * Tests for the Gradle entry point.
 *
 * Two silent failures live here, and neither shows up as a non-zero exit:
 *
 *   - Arguments after the task name were dropped, so the documented
 *     `npm run android:build:release -- -PRELEASE_STORE_FILE=…` never reached
 *     Gradle. The signingConfig stayed empty and AGP wrote
 *     app-release-unsigned.apk while npm reported success.
 *   - Nothing checked which APK actually came out, so that unsigned file was
 *     the thing an operator uploaded — INSTALL_PARSE_FAILED_NO_CERTIFICATES on
 *     the user's phone was the first error message in the whole chain.
 *
 * The wrapper invocation runs for real against a stub `gradlew` that records
 * its argv (`OT_ANDROID_DIR`), so this covers the spawn path too — not just the
 * pure helpers.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateGradleArgs, unsignedReleaseProblem } from './run-gradle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'run-gradle.mjs')
const isWindows = process.platform === 'win32'

/** A throwaway android dir whose gradlew only writes down how it was called. */
function stubAndroidDir() {
  const dir = mkdtempSync(join(tmpdir(), 'run-gradle-'))
  const log = join(dir, 'argv.txt')
  if (isWindows) {
    // %* keeps the arguments exactly as the wrapper received them.
    writeFileSync(join(dir, 'gradlew.bat'), `@echo off\r\n>"${log}" echo %*\r\nexit /b 0\r\n`)
  } else {
    writeFileSync(join(dir, 'gradlew'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}"\nexit 0\n`, { mode: 0o755 })
  }
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const run = (dir, args) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    env: { ...process.env, OT_ANDROID_DIR: dir },
    encoding: 'utf8',
  })

describe('forwarding arguments to Gradle', () => {
  test('the task alone reaches the wrapper', () => {
    const { dir, log, cleanup } = stubAndroidDir()
    try {
      const r = run(dir, ['assembleDebug'])
      assert.equal(r.status, 0, r.stderr)
      assert.match(readFileSync(log, 'utf8'), /assembleDebug/)
    } finally {
      cleanup()
    }
  })

  /** The regression that made the documented release route silently useless. */
  test('signing properties are passed through instead of dropped', () => {
    const { dir, log, cleanup } = stubAndroidDir()
    try {
      const r = run(dir, [
        'assembleRelease',
        '-PRELEASE_STORE_FILE=/keys/ot.jks',
        '-PRELEASE_STORE_PASSWORD=hunter2',
        '-PRELEASE_KEY_ALIAS=p13release',
        '-PRELEASE_KEY_PASSWORD=hunter2',
      ])
      assert.equal(r.status, 0, r.stderr)
      const argv = readFileSync(log, 'utf8')
      for (const p of ['RELEASE_STORE_FILE', 'RELEASE_STORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD']) {
        assert.match(argv, new RegExp(`-P${p}=`), `${p} never reached Gradle`)
      }
    } finally {
      cleanup()
    }
  })

  test('an arbitrary flag is refused rather than handed to Gradle', () => {
    const { dir, log, cleanup } = stubAndroidDir()
    try {
      const r = run(dir, ['assembleDebug', '--init-script=/tmp/evil.gradle'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /Refusing to pass/)
      assert.ok(!existsSync(log), 'Gradle must not run at all when an argument is refused')
    } finally {
      cleanup()
    }
  })

  test('read-only diagnostics are allowed', () => {
    assert.deepEqual(validateGradleArgs(['--stacktrace', '-PVERSION_NAME=1.2.3']), [
      '--stacktrace',
      '-PVERSION_NAME=1.2.3',
    ])
    assert.throws(() => validateGradleArgs(['-Pnot valid']), /Refusing/)
    assert.throws(() => validateGradleArgs(['--exec']), /Refusing/)
  })

  test('an invalid task name never reaches the wrapper', () => {
    const { dir, log, cleanup } = stubAndroidDir()
    try {
      const r = run(dir, ['assembleDebug; rm -rf /'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /Invalid Gradle task name/)
      assert.ok(!existsSync(log))
    } finally {
      cleanup()
    }
  })
})

describe('catching an unsigned release', () => {
  const outDir = (dir) => join(dir, 'app', 'build', 'outputs', 'apk', 'release')

  test('an unsigned-only release build is reported as a failure', () => {
    const { dir, cleanup } = stubAndroidDir()
    try {
      mkdirSync(outDir(dir), { recursive: true })
      writeFileSync(join(outDir(dir), 'app-release-unsigned.apk'), 'x')
      const r = run(dir, ['assembleRelease'])
      assert.equal(r.status, 1, 'a build that produced only an unsigned APK must not report success')
      assert.match(r.stderr, /unsigned/i)
    } finally {
      cleanup()
    }
  })

  test('a signed release passes', () => {
    const { dir, cleanup } = stubAndroidDir()
    try {
      mkdirSync(outDir(dir), { recursive: true })
      writeFileSync(join(outDir(dir), 'app-release.apk'), 'x')
      assert.equal(run(dir, ['assembleRelease']).status, 0)
    } finally {
      cleanup()
    }
  })

  test('debug builds are not subject to the check', () => {
    const { dir, cleanup } = stubAndroidDir()
    try {
      assert.equal(unsignedReleaseProblem(dir, 'assembleDebug'), null)
      assert.equal(run(dir, ['assembleDebug']).status, 0)
    } finally {
      cleanup()
    }
  })

  test('a release with no outputs at all is left to Gradle to explain', () => {
    const { dir, cleanup } = stubAndroidDir()
    try {
      assert.equal(unsignedReleaseProblem(dir, 'assembleRelease'), null)
    } finally {
      cleanup()
    }
  })
})

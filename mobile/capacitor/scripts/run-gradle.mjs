import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const isWindows = platform() === 'win32'

/**
 * Everything after the task name is forwarded to Gradle.
 *
 * It used to be dropped on the floor, which made the documented release route
 * (`npm run android:build:release -- -PRELEASE_STORE_FILE=…`) a lie: the
 * properties never reached Gradle, the `release` signingConfig stayed empty,
 * and AGP happily produced **app-release-unsigned.apk** while npm reported
 * success. The first error in the whole chain was
 * INSTALL_PARSE_FAILED_NO_CERTIFICATES, on a user's phone.
 *
 * Only `-P` properties and a few read-only diagnostics are allowed through, so
 * this stays a build entry point rather than an arbitrary Gradle shell.
 */
const ALLOWED_FLAGS = new Set(['--stacktrace', '--info', '--debug', '--warning-mode=all', '--offline'])

export function validateGradleArgs(extra) {
  for (const arg of extra) {
    if (/^-P[A-Za-z_][A-Za-z0-9_.]*=/.test(arg)) continue
    if (ALLOWED_FLAGS.has(arg)) continue
    throw new Error(
      `[android] Refusing to pass ${arg} to Gradle — only -PNAME=value and ${[...ALLOWED_FLAGS].join(', ')} are allowed.`
    )
  }
  return extra
}

/**
 * A release build with no signing properties does not fail — Gradle writes
 * `app-release-unsigned.apk` and returns 0. Shipping that file is worse than
 * failing: it installs nowhere, and the operator finds out from a user.
 */
export function unsignedReleaseProblem(dir, gradleTask) {
  if (!/assembleRelease|bundleRelease/i.test(gradleTask)) return null
  const out = resolve(dir, 'app', 'build', 'outputs', 'apk', 'release')
  if (existsSync(resolve(out, 'app-release.apk'))) return null
  if (existsSync(resolve(out, 'app-release-unsigned.apk'))) {
    return (
      'Gradle produced app-release-unsigned.apk and no signed APK: the release ' +
      'signing properties were missing. Pass -PRELEASE_STORE_FILE, ' +
      '-PRELEASE_STORE_PASSWORD, -PRELEASE_KEY_ALIAS and -PRELEASE_KEY_PASSWORD ' +
      '(or use scripts/build-apk.sh release <keystore.jks>).'
    )
  }
  return null
}

/**
 * Windows self-heal for a Gradle mergeAssets failure.
 *
 * Next.js 16's static export emits read-only `__next.*` RSC payload files (e.g.
 * `out/admin/__next.admin`). After `cap sync` copies them into the Android
 * assets, Gradle's incremental `mergeDebug/ReleaseAssets` copies them into a
 * build intermediate and, on the NEXT build, fails with
 * `java.nio.file.AccessDeniedException` trying to overwrite the read-only
 * intermediate — `android:clean` only wipes `client/out`, never the Gradle
 * build dir, so the read-only artifact persists and the APK never builds.
 *
 * Before each Gradle run we clear the read-only bit on the synced assets and
 * drop the stale assets merge intermediate so the merge always starts clean.
 */
function clearReadonlyRecursive(dir) {
  if (!existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = resolve(dir, entry.name)
    try {
      if (entry.isDirectory()) clearReadonlyRecursive(p)
      else chmodSync(p, 0o666) // clears the read-only attribute on Windows
    } catch {
      /* best-effort */
    }
  }
  try {
    chmodSync(dir, 0o777)
  } catch {
    /* best-effort */
  }
}

function main() {
  const task = process.argv[2]

  if (!task) {
    console.error('[android] Missing Gradle task name.')
    process.exit(1)
  }
  if (!/^[A-Za-z0-9_:.-]+$/.test(task)) {
    console.error(`[android] Invalid Gradle task name: ${task}`)
    process.exit(1)
  }

  let extraArgs
  try {
    extraArgs = validateGradleArgs(process.argv.slice(3))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  // `OT_ANDROID_DIR` exists so the wrapper invocation can be exercised against
  // a stub gradlew instead of a ten-minute real build.
  const androidDir = process.env.OT_ANDROID_DIR
    ? resolve(process.env.OT_ANDROID_DIR)
    : resolve(here, '..', 'android')

  if (isWindows) {
    clearReadonlyRecursive(resolve(androidDir, 'app', 'src', 'main', 'assets'))
    const mergeIntermediate = resolve(androidDir, 'app', 'build', 'intermediates', 'assets')
    clearReadonlyRecursive(mergeIntermediate)
    try {
      rmSync(mergeIntermediate, { recursive: true, force: true })
    } catch {
      /* best-effort — the clear above already lets the merge overwrite */
    }
  }

  const wrapper = isWindows ? resolve(androidDir, 'gradlew.bat') : resolve(androidDir, 'gradlew')

  // Git may check out `gradlew` without its executable bit (e.g. cloned/zipped
  // from a Windows-authored tree), which makes the direct `spawn(wrapper)`
  // below fail with EACCES on Linux/macOS/CI. Restore it before running.
  if (!isWindows) {
    try {
      chmodSync(wrapper, 0o755)
    } catch {
      /* best-effort — falls through to the spawn, which will surface any error */
    }
  }

  const command = isWindows ? process.env.ComSpec || 'cmd.exe' : wrapper
  const args = isWindows ? ['/d', '/s', '/c', wrapper, task, ...extraArgs] : [task, ...extraArgs]

  const child = spawn(command, args, { cwd: androidDir, stdio: 'inherit', shell: false })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    if (code === 0) {
      const problem = unsignedReleaseProblem(androidDir, task)
      if (problem) {
        console.error(`[android] ${problem}`)
        process.exit(1)
      }
    }
    process.exit(code ?? 1)
  })
}

// Importing this file (the tests do) must not spawn Gradle.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

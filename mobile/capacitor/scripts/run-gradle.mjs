import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'

const task = process.argv[2]

if (!task) {
  console.error('[android] Missing Gradle task name.')
  process.exit(1)
}

if (!/^[A-Za-z0-9_:.-]+$/.test(task)) {
  console.error(`[android] Invalid Gradle task name: ${task}`)
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const androidDir = resolve(here, '..', 'android')
const isWindows = platform() === 'win32'

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

const wrapper = isWindows
  ? resolve(androidDir, 'gradlew.bat')
  : resolve(androidDir, 'gradlew')

const command = isWindows ? process.env.ComSpec || 'cmd.exe' : wrapper
const args = isWindows ? ['/d', '/s', '/c', wrapper, task] : [task]

const child = spawn(command, args, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: false,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

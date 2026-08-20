/**
 * Which `bash` the shell-script tests should spawn.
 *
 * On Windows `bash` on PATH is `C:\Windows\System32\bash.exe` — the WSL relay.
 * Unless a real distribution is installed it answers every invocation with
 *
 *     <3>WSL (45 - Relay) ERROR: CreateProcessCommon:818:
 *       execvpe(/bin/bash) failed: No such file or directory
 *
 * and a non-zero status, which is why `npm run test:scripts` reported ten
 * failures in `env-value.test.mjs` on a machine that has a perfectly good bash:
 * the one Git for Windows ships, which every developer on this repo already has
 * (the repo's own hooks and `test:e2e:local` run through it).
 *
 * So: prefer an explicit `TEST_BASH`, then Git Bash at its standard locations,
 * then whatever is on PATH — and expose `hasBash` so a host with none skips
 * these suites instead of failing them, the way `build-stamp.test.mjs` already
 * did on its own.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function candidates() {
  const explicit = process.env.TEST_BASH?.trim()
  if (explicit) return [explicit]
  if (process.platform !== 'win32') return ['bash']
  return [
    // Git for Windows. `bin\bash.exe` is the wrapper Git itself calls;
    // `usr\bin\bash.exe` is the same shell one level down, present in some
    // installs where the wrapper is not.
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    // Last resort — may well be the WSL relay, which the probe below rejects.
    'bash',
  ]
}

function works(bin) {
  try {
    const r = spawnSync(bin, ['-c', 'echo ok'], { encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim() === 'ok'
  } catch {
    return false
  }
}

function resolve() {
  for (const bin of candidates()) {
    // An absolute path that isn't there can be skipped without paying for a
    // process spawn; a bare name has to be probed.
    if (bin.includes('\\') && !existsSync(bin)) continue
    if (works(bin)) return bin
  }
  return null
}

/** Absolute path (or bare `bash`) of a working shell — null if there is none. */
export const BASH = resolve()

/** False on a host with no usable bash; such a host SKIPS, never fails. */
export const hasBash = BASH !== null

/** Run a script through the resolved shell. Throws if there is no shell. */
export function runBash(script, options = {}) {
  if (!BASH) throw new Error('no usable bash on this host')
  return spawnSync(BASH, ['-c', script], { encoding: 'utf8', ...options })
}

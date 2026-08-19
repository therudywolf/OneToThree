#!/usr/bin/env node
/**
 * Self-host desktop build — points the Tauri app at YOUR server instead of the
 * hardcoded api/s3.onetothree.ru, and regenerates the CSP allow-list from your
 * hosts + feature toggles.
 *
 * Usage:
 *   1. cp desktop/tauri/.env.example desktop/tauri/.env  (then edit it)
 *   2. cd desktop/tauri && npm run build:selfhost         (add -- --bundles nsis to pick a target)
 *
 * Reads desktop/tauri/.env (falls back to onetothree.ru so the maintainer build
 * still works with no .env). Everything is derived from OT_* vars — nothing
 * about the target server is hardcoded here.
 *
 * The decisions (targets, CSP, config override) live in ./selfhost-core.mjs so
 * they are unit-tested; this file only does I/O and spawning.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvFile, resolveTargets, buildOverride, nextPublicEnv } from './selfhost-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAURI_DIR = join(HERE, '..') // desktop/tauri
const REPO_ROOT = join(TAURI_DIR, '..', '..')

// ── 1. Load desktop/tauri/.env (simple KEY=VALUE, no deps) ──────────────────
const envFile = join(TAURI_DIR, '.env')
const fromFile = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {}
const env = { ...fromFile, ...process.env }

let targets
try {
  targets = resolveTargets(env)
} catch (e) {
  console.error(e.message)
  console.error('[selfhost] fix desktop/tauri/.env (see .env.example) and re-run.')
  process.exit(1)
}

// ── 2. Config override: CSP for the resolved hosts + no frontend re-export ───
const overridePath = join(TAURI_DIR, 'tauri.selfhost.gen.json')
writeFileSync(overridePath, JSON.stringify(buildOverride(targets), null, 2) + '\n')

console.log('[selfhost] target:')
console.log(`  API   ${targets.api}`)
console.log(`  APP   ${targets.app}`)
console.log(`  S3    ${targets.s3}`)
console.log(
  `  calls ${targets.enableCalls ? targets.livekit : 'disabled'} | gif ${targets.enableGif ? 'on' : 'off'}`
)
console.log(`  wrote ${overridePath}`)

// ── 3. Static export with the target's NEXT_PUBLIC_* vars ───────────────────
const buildEnv = { ...process.env, ...nextPublicEnv(targets) }
function run(cmd, args, opts = {}) {
  console.log(`[selfhost] $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) {
    console.error(`[selfhost] FAILED: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}
run('npm', ['--prefix', REPO_ROOT, 'run', 'build:client:export:env'], { env: buildEnv })

// ── 4. Tauri build with the generated override (+ any extra CLI args) ────────
// The override also clears `beforeBuildCommand`, so Tauri does NOT re-run the
// public-instance export over the one we just made. See selfhost-core.mjs.
const extra = process.argv.slice(2)
run('npx', ['tauri', 'build', '-c', overridePath, ...extra], { cwd: TAURI_DIR })

console.log('[selfhost] done. Installer(s) under src-tauri/target/release/bundle/.')

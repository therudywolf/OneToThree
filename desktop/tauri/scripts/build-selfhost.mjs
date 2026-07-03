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
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAURI_DIR = join(HERE, '..') // desktop/tauri
const REPO_ROOT = join(TAURI_DIR, '..', '..')

// ── 1. Load desktop/tauri/.env (simple KEY=VALUE, no deps) ──────────────────
function loadEnv(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}
const env = { ...loadEnv(join(TAURI_DIR, '.env')), ...process.env }

const API_URL = (env.OT_API_URL || 'https://api.onetothree.ru').replace(/\/$/, '')
const APP_URL = (env.OT_APP_URL || 'https://onetothree.ru').replace(/\/$/, '')
const S3_URL = (env.OT_S3_URL || 'https://s3.onetothree.ru').replace(/\/$/, '')
const LIVEKIT_URL = (env.OT_LIVEKIT_URL || 'wss://lk.onetothree.ru').replace(/\/$/, '')
const bool = (v, d) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)))
const ENABLE_CALLS = bool(env.OT_ENABLE_CALLS, true)
const ENABLE_GIF = bool(env.OT_ENABLE_GIF, true)

// ── 2. Build the CSP from the resolved hosts + toggles ──────────────────────
const wsApi = API_URL.replace(/^http/, 'ws')
const wsLk = LIVEKIT_URL.replace(/^http/, 'ws')
const httpLk = LIVEKIT_URL.replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'))
const GIF_HOSTS = ENABLE_GIF
  ? 'https://*.giphy.com https://api.giphy.com https://media.tenor.com https://*.tenor.com https://api.tenor.com https://tenor.googleapis.com'
  : ''
const CALL_CONNECT = ENABLE_CALLS ? `${wsLk} ${httpLk}` : ''

const csp = [
  `default-src 'self' tauri://localhost`,
  `script-src 'self' tauri://localhost 'unsafe-inline'`,
  `style-src 'self' tauri://localhost 'unsafe-inline'`,
  `img-src 'self' tauri://localhost blob: data: ${API_URL} ${S3_URL} ${GIF_HOSTS}`.trim(),
  `media-src 'self' tauri://localhost blob: ${API_URL} ${S3_URL} ${GIF_HOSTS}`.trim(),
  `connect-src 'self' tauri://localhost ${API_URL} ${wsApi} ${S3_URL} ${CALL_CONNECT} ${GIF_HOSTS}`.replace(/\s+/g, ' ').trim(),
  `worker-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `object-src 'none'`,
].join('; ')

const overridePath = join(TAURI_DIR, 'tauri.selfhost.gen.json')
writeFileSync(
  overridePath,
  JSON.stringify({ app: { security: { csp } } }, null, 2) + '\n'
)

console.log('[selfhost] target:')
console.log(`  API   ${API_URL}`)
console.log(`  APP   ${APP_URL}`)
console.log(`  S3    ${S3_URL}`)
console.log(`  calls ${ENABLE_CALLS ? LIVEKIT_URL : 'disabled'} | gif ${ENABLE_GIF ? 'on' : 'off'}`)
console.log(`  wrote ${overridePath}`)

// ── 3. Static export with the target's NEXT_PUBLIC_* vars ───────────────────
const buildEnv = {
  ...process.env,
  NEXT_PUBLIC_API_URL: API_URL,
  NEXT_PUBLIC_APP_URL: APP_URL,
  NEXT_PUBLIC_WS_ORIGIN: API_URL,
}
function run(cmd, args, opts = {}) {
  console.log(`[selfhost] $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) {
    console.error(`[selfhost] FAILED: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}
run('npm', ['--prefix', REPO_ROOT, 'run', 'build:client:export:env'], { env: buildEnv })

// ── 4. Tauri build with the generated CSP override (+ any extra CLI args) ────
const extra = process.argv.slice(2)
run('npx', ['tauri', 'build', '-c', overridePath, ...extra], { cwd: TAURI_DIR })

console.log('[selfhost] done. Installer(s) under src-tauri/target/release/bundle/.')

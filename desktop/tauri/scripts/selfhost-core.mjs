/**
 * Self-host desktop build — pure core.
 *
 * Everything `build-selfhost.mjs` decides *before* it spawns anything lives
 * here, so it can be tested without a Rust toolchain: which server the app is
 * pointed at, the CSP allow-list derived from it, the `NEXT_PUBLIC_*` the static
 * export is built with, and the Tauri config override that ties them together.
 *
 * Zero dependencies (Node built-ins only) — the desktop build must work from a
 * fresh clone with just `npm ci`.
 */

/** Parse a simple `KEY=VALUE` env file. Comments, quotes and CRLF tolerated. */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    // Only the FIRST `=` splits, so a value may contain `=` (base64, query strings).
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)))
const strip = (u) => String(u).trim().replace(/\/+$/, '')

/**
 * A CSP source has to be an absolute origin. A typo (`api.example.com` with no
 * scheme, a path glued on, an env var that expanded to nothing) does not fail
 * the build — it silently produces an allow-list that matches nothing, and the
 * installer ships an app that cannot reach its own server. Fail here instead.
 */
function requireOrigin(label, value, schemes) {
  let u
  try {
    u = new URL(value)
  } catch {
    throw new Error(`[selfhost] ${label} is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (!schemes.includes(u.protocol)) {
    throw new Error(
      `[selfhost] ${label} must use ${schemes.join(' or ')} — got ${JSON.stringify(value)}`
    )
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    throw new Error(`[selfhost] ${label} must be a bare origin (no path) — got ${JSON.stringify(value)}`)
  }
  return u.origin
}

export const DEFAULT_TARGETS = {
  api: 'https://api.onetothree.ru',
  app: 'https://onetothree.ru',
  s3: 'https://s3.onetothree.ru',
  livekit: 'wss://lk.onetothree.ru',
}

/**
 * Resolve the target server from `OT_*` vars. Unset falls back to the public
 * instance so the maintainer build needs no `.env`.
 */
export function resolveTargets(env = {}) {
  const api = requireOrigin('OT_API_URL', strip(env.OT_API_URL || DEFAULT_TARGETS.api), ['http:', 'https:'])
  const app = requireOrigin('OT_APP_URL', strip(env.OT_APP_URL || DEFAULT_TARGETS.app), ['http:', 'https:'])
  const s3 = requireOrigin('OT_S3_URL', strip(env.OT_S3_URL || DEFAULT_TARGETS.s3), ['http:', 'https:'])
  const enableCalls = bool(env.OT_ENABLE_CALLS, true)
  const enableGif = bool(env.OT_ENABLE_GIF, true)
  // LiveKit is only validated when calls are on — an instance without an SFU is
  // allowed to leave the var empty or wrong rather than fail the build.
  const livekit = enableCalls
    ? requireOrigin(
        'OT_LIVEKIT_URL',
        strip(env.OT_LIVEKIT_URL || DEFAULT_TARGETS.livekit),
        ['ws:', 'wss:', 'http:', 'https:']
      )
    : ''
  return { api, app, s3, livekit, enableCalls, enableGif }
}

const GIF_HOSTS =
  'https://*.giphy.com https://api.giphy.com https://media.tenor.com https://*.tenor.com https://api.tenor.com https://tenor.googleapis.com'

/** `https://x` → `wss://x`, `http://x` → `ws://x` (and the reverse). */
export const toWs = (origin) => String(origin).replace(/^http/, 'ws')
export const toHttp = (origin) => String(origin).replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'))

/** CSP allow-list for the resolved target. */
export function buildCsp(t) {
  const gif = t.enableGif ? GIF_HOSTS : ''
  const call = t.enableCalls && t.livekit ? `${toWs(t.livekit)} ${toHttp(t.livekit)}` : ''
  const d = (...parts) => parts.join(' ').replace(/\s+/g, ' ').trim()
  return [
    d(`default-src 'self' tauri://localhost`),
    d(`script-src 'self' tauri://localhost 'unsafe-inline'`),
    d(`style-src 'self' tauri://localhost 'unsafe-inline'`),
    d(`img-src 'self' tauri://localhost blob: data:`, t.api, t.s3, gif),
    d(`media-src 'self' tauri://localhost blob:`, t.api, t.s3, gif),
    d(`connect-src 'self' tauri://localhost`, t.api, toWs(t.api), t.s3, call, gif),
    d(`worker-src 'self' blob:`),
    d(`frame-ancestors 'none'`),
    d(`object-src 'none'`),
  ].join('; ')
}

/** The `NEXT_PUBLIC_*` the static export must be built with for this target. */
export function nextPublicEnv(t) {
  return {
    NEXT_PUBLIC_API_URL: t.api,
    NEXT_PUBLIC_APP_URL: t.app,
    NEXT_PUBLIC_WS_ORIGIN: t.api,
  }
}

/**
 * The `-c` override handed to `tauri build`.
 *
 * `beforeBuildCommand` is neutralised ON PURPOSE. tauri.conf.json runs
 * `npm run build:client:export`, and that script hardcodes
 * `NEXT_PUBLIC_API_URL=https://api.onetothree.ru`. Since `tauri build` runs it
 * *after* this script's own export, it overwrote `client/out` with a frontend
 * pointing at the public instance while the CSP still only allowed the
 * operator's own hosts — every self-host installer shipped an app that could
 * not reach any server at all. The export is already done by the time Tauri
 * starts, so the hook has nothing left to do.
 */
export function buildOverride(t) {
  return {
    build: { beforeBuildCommand: '' },
    app: { security: { csp: buildCsp(t) } },
  }
}

/**
 * OneToThree Lite — shared installer core.
 *
 * Pure, side-effect-light building blocks used by BOTH the text CLI
 * (`install.mjs`) and the graphical first-run wizard (`wizard/server.mjs`), so
 * the two never drift: same secrets, same `.env.lite`, same `infra/lite/Caddyfile`,
 * same `docker compose` invocation. Zero external dependencies (Node built-ins
 * only) — the installer must run against a fresh clone before `npm install`.
 *
 * See docs/guides/LITE.md and docs/project/ROADMAP_SELFHOST_LITE.md.
 */
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

export const hex = (n) => randomBytes(n).toString('hex')

/**
 * User-facing feature checkboxes (single source of truth for CLI + GUI).
 * `ADMIN` and `GROUPS` exist as flags too but stay on by default and are not
 * surfaced as checkboxes — parity with the original CLI.
 */
export const FEATURES = [
  { key: 'MEDIA', label: 'Media — photos / voice / video / files', on: true },
  { key: 'CALLS', label: 'Calls — voice / video (external LiveKit)', on: false },
  { key: 'STICKERS', label: 'Stickers (import + create your own)', on: true },
  { key: 'GIF', label: 'GIF search (Tenor / Giphy)', on: true },
  { key: 'PUSH', label: 'Push notifications (Web Push)', on: false },
  { key: '2FA', label: 'Two-factor auth (TOTP)', on: true },
]

/**
 * Generate a Web-Push VAPID keypair with Node crypto only (no `web-push` dep).
 * Public key = uncompressed P-256 point (0x04‖X‖Y) as base64url (87 chars);
 * private key = the 32-byte scalar `d` as base64url (43 chars). This fills a
 * real gap: the old CLI toggled PUSH on but never generated these, so push was
 * silently dead until the operator hand-filled them.
 */
export function generateVapidKeys(subject = 'mailto:admin@localhost') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  const x = Buffer.from(pub.x, 'base64url')
  const y = Buffer.from(pub.y, 'base64url')
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: priv.d, // JWK `d` is already base64url
    subject,
  }
}

/**
 * Resolve everything that depends on the deployment mode. The three modes exist
 * because E2EE (Web Crypto / crypto.subtle) only runs in a SECURE CONTEXT:
 * HTTPS, or plain HTTP on `localhost`. So plain HTTP works on this machine but
 * not over a LAN IP.
 *   local  → http://localhost:<port>            (dev, insecure cookie, works here only)
 *   lan    → https://<ip>:<port> (self-signed)  (reachable off-box; browser warns once)
 *   domain → https://<domain>    (Let's Encrypt) (public server)
 */
export function computeModeConfig(mode, opts = {}) {
  if (mode === 'lan') {
    const host = (opts.host || '192.168.1.50').trim()
    const httpsPort = String(opts.httpsPort || '8443').trim()
    return {
      mode: 'lan',
      host,
      domain: '',
      acmeEmail: '',
      httpsPort,
      httpPort: String(Number(httpsPort) + 1), // idle; HTTPS is the one you use
      httpsContainerPort: httpsPort, // map host HTTPS port 1:1 so host:port matches the cert
      origin: `https://${host}:${httpsPort}`,
      nodeEnv: 'production',
      cookieSecure: '1',
      s3PublicDefault: '', // self-signed blocks cross-origin media without a trusted CA
    }
  }
  if (mode === 'domain') {
    const domain = (opts.domain || 'chat.example.com').trim()
    const acmeEmail = (opts.acmeEmail || `admin@${domain.replace(/^[^.]+\./, '')}`).trim()
    return {
      mode: 'domain',
      host: domain,
      domain,
      acmeEmail,
      httpPort: '80',
      httpsPort: '443',
      httpsContainerPort: '443',
      origin: `https://${domain}`,
      nodeEnv: 'production',
      cookieSecure: '1',
      s3PublicDefault: '', // bundled MinIO is :9000-only; front it with your own s3.<domain>
    }
  }
  // local (default)
  const httpPort = String(opts.httpPort || '8443').trim()
  return {
    mode: 'local',
    host: 'localhost',
    domain: '',
    acmeEmail: '',
    httpPort,
    httpsPort: String(Number(httpPort) + 1), // idle in local mode
    httpsContainerPort: '443',
    origin: `http://localhost:${httpPort}`,
    nodeEnv: 'development',
    cookieSecure: '0',
    s3PublicDefault: 'http://localhost:9000', // same-scheme + secure-context → media just works
  }
}

/**
 * Secrets that MUST survive a re-run of the installer.
 *
 * The guide tells operators to re-run it to change mode or features, and that
 * used to mint a fresh set — which bricks an existing install. Postgres and
 * MinIO only apply their root credentials on FIRST init, so the volumes keep
 * the old ones and the stack comes up with `password authentication failed`.
 * Rotating the other two is quieter and worse: a new TOTP_WRAP_KEY makes every
 * enrolled 2FA secret undecryptable, and a new JWT_SECRET logs everyone out.
 */
const PERSISTENT_SECRETS = [
  'OT_DB_PASSWORD',
  'OT_JWT_SECRET',
  'OT_TOTP_WRAP_KEY',
  'OT_MINIO_PASSWORD',
  'OT_VAPID_PUBLIC_KEY',
  'OT_VAPID_PRIVATE_KEY',
]

/** Parse an existing `.env.lite` into a map. `{}` when there isn't one yet. */
export function readExistingEnv(repo) {
  const path = join(repo, '.env.lite')
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * Build the `.env.lite` variable map. `flags` is `{ MEDIA:'1', CALLS:'0', … }`.
 * VAPID keys are appended only when PUSH is on (keeps the non-push output
 * identical to the historical CLI).
 *
 * Pass `existing` (from {@link readExistingEnv}) to keep the credentials the
 * running volumes were created with — see PERSISTENT_SECRETS.
 */
export function buildEnv({ cfg, flags, s3PublicUrl = '', livekit = {}, vapid = null, existing = {} }) {
  const env = {
    OT_MODE: cfg.mode,
    OT_ORIGIN: cfg.origin,
    // Host part of every published port. `local` pins to 127.0.0.1 — it means
    // this machine only, and it dodges Docker Desktop's IPv6 listener, which
    // accepts the connection and answers nothing (the URL the installer prints
    // resolves to ::1 first, so the browser got ERR_EMPTY_RESPONSE with no
    // fallback). The other modes have to stay on 0.0.0.0 to be reachable.
    OT_BIND: cfg.mode === 'local' ? '127.0.0.1:' : '',
    OT_HTTP_PORT: cfg.httpPort,
    OT_HTTPS_PORT: cfg.httpsPort,
    OT_HTTPS_CONTAINER_PORT: cfg.httpsContainerPort,
    OT_NODE_ENV: cfg.nodeEnv,
    OT_COOKIE_SECURE: cfg.cookieSecure,
    OT_DB_PASSWORD: hex(16),
    OT_JWT_SECRET: hex(32),
    OT_TOTP_WRAP_KEY: hex(32),
    OT_MINIO_USER: 'minio',
    OT_MINIO_PASSWORD: hex(20),
    OT_MINIO_PORT: '9000',
    OT_S3_PUBLIC_URL: s3PublicUrl || cfg.s3PublicDefault,
    OT_ENABLE_MEDIA: flags.MEDIA,
    OT_ENABLE_CALLS: flags.CALLS,
    OT_ENABLE_STICKERS: flags.STICKERS,
    OT_ENABLE_GIF: flags.GIF,
    OT_ENABLE_PUSH: flags.PUSH,
    OT_ENABLE_2FA: flags['2FA'],
    // Without this the API keeps its `origin_safe` default, where
    // /call/config reports `livekit_enabled: false` regardless of the three
    // vars below — and the client takes the WebSocket audio relay without ever
    // asking for an SFU token. A configured LiveKit was simply ignored.
    OT_CALL_MEDIA_MODE: livekit.url ? 'self_hosted' : 'origin_safe',
    OT_LIVEKIT_URL: livekit.url || '',
    OT_LIVEKIT_API_KEY: livekit.key || '',
    OT_LIVEKIT_API_SECRET: livekit.secret || '',
  }
  if (flags.PUSH === '1') {
    const v = vapid || generateVapidKeys()
    env.OT_VAPID_PUBLIC_KEY = v.publicKey
    env.OT_VAPID_PRIVATE_KEY = v.privateKey
    env.OT_VAPID_SUBJECT = v.subject || 'mailto:admin@localhost'
  }
  // Keep what the existing volumes were created with. Anything the caller did
  // NOT explicitly supply this run falls back to the previous value; a caller
  // that deliberately passes new VAPID keys still wins.
  for (const key of PERSISTENT_SECRETS) {
    if (!existing[key]) continue
    if (key.startsWith('OT_VAPID') && vapid) continue
    if (key in env) env[key] = existing[key]
  }
  if (flags.PUSH === '1' && existing.OT_VAPID_SUBJECT && !vapid) {
    env.OT_VAPID_SUBJECT = existing.OT_VAPID_SUBJECT
  }
  return env
}

export function renderEnvFile(env) {
  return (
    '# Generated by the OneToThree Lite installer — contains secrets, do not commit.\n' +
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n'
  )
}

/** Per-mode Caddyfile. Caddy requires each block's `{` to end its line. */
export function renderCaddyfile(cfg) {
  const routes = [
    '\t# Root-level health passthrough (installer + Docker healthcheck).',
    '\thandle /health {',
    '\t\treverse_proxy api:8080',
    '\t}',
    '\t# REST + WebSocket (/api/ws) → the API. reverse_proxy upgrades WS natively.',
    '\thandle /api/* {',
    '\t\treverse_proxy api:8080',
    '\t}',
    '\t# Everything else → the Next server.',
    '\thandle {',
    '\t\treverse_proxy web:3000',
    '\t}',
  ].join('\n')
  if (cfg.mode === 'local') return `{\n\tauto_https off\n}\n\n:80 {\n${routes}\n}\n`
  if (cfg.mode === 'lan') {
    return `{\n\tauto_https disable_redirects\n}\n\nhttps://${cfg.host}:${cfg.httpsPort} {\n\ttls internal\n${routes}\n}\n`
  }
  return `{\n\temail ${cfg.acmeEmail}\n}\n\n${cfg.domain} {\n${routes}\n}\n`
}

/** `docker compose …` args. Only the `media` profile (MinIO) is bundled. */
export function composeArgs(flags, extra = []) {
  const profiles = []
  if (flags.MEDIA === '1' || flags.STICKERS === '1') profiles.push('media')
  return [
    'compose',
    '--env-file',
    '.env.lite',
    '-f',
    'docker-compose.lite.yml',
    ...profiles.flatMap((p) => ['--profile', p]),
    ...extra,
  ]
}

/** Write `.env.lite` + `infra/lite/Caddyfile` under `repo`. */
export function writeArtifacts(repo, env, caddyfile) {
  writeFileSync(join(repo, '.env.lite'), renderEnvFile(env))
  mkdirSync(join(repo, 'infra', 'lite'), { recursive: true })
  writeFileSync(join(repo, 'infra', 'lite', 'Caddyfile'), caddyfile)
}

/** Best-guess LAN IPv4 (first non-internal), for the `lan` host default. */
export function suggestLanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '192.168.1.50'
}

/** Preflight: is Docker + Compose v2 present? (Node is implied — we're running.) */
export function preflight() {
  const check = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
      const out = (r.stdout || r.stderr || '').trim().split('\n')[0] || ''
      return { ok: r.status === 0, detail: out }
    } catch (e) {
      return { ok: false, detail: e?.message || 'not found' }
    }
  }
  return {
    docker: check('docker', ['--version']),
    compose: check('docker', ['compose', 'version']),
    node: { ok: true, detail: process.version },
  }
}

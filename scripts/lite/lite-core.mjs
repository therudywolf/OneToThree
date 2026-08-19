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
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

export const hex = (n) => randomBytes(n).toString('hex')

/**
 * Reject anything that would break out of a `KEY=VALUE` line or a Caddyfile
 * block. Both artifacts are line-oriented and unquoted, so a newline in an
 * operator-supplied value (pasted domain, S3 URL, LiveKit secret) does not fail
 * — it appends whatever follows as a new env var or a new Caddy directive.
 */
export function assertSingleLine(label, value) {
  const s = String(value ?? '')
  if (/[\r\n]/.test(s)) throw new Error(`${label} must not contain a line break`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) throw new Error(`${label} contains a control character`)
  return s
}

/**
 * A host has to survive being written into a Caddy site address and a URL. A
 * value with a space, a brace or a slash silently produces a Caddyfile that
 * either fails to parse or serves a site nobody asked for.
 */
export function assertHost(label, value) {
  const s = assertSingleLine(label, value).trim()
  if (!s) throw new Error(`${label} must not be empty`)
  const ok =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(s) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
  if (!ok) throw new Error(`${label} is not a valid hostname or IPv4 address: ${JSON.stringify(s)}`)
  return s
}

/**
 * Ports end up in `docker compose` published-port strings and in the origin the
 * installer prints. A non-numeric answer used to become `NaN` there: compose
 * refuses to start on an invalid published port, and the operator is told
 * nothing about which answer caused it.
 */
export function parsePort(label, value, fallback) {
  const raw = String(value ?? '').trim()
  if (!raw) return String(fallback)
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a number, got ${JSON.stringify(raw)}`)
  const n = Number(raw)
  if (n < 1 || n > 65535) throw new Error(`${label} must be between 1 and 65535, got ${n}`)
  return String(n)
}

/** Normalize a contact into a valid VAPID `mailto:`/`https:` subject. */
export function normalizeSubject(s) {
  const t = assertSingleLine('push contact', s || '').trim() || 'mailto:admin@localhost'
  return t.startsWith('mailto:') || t.startsWith('https:') ? t : `mailto:${t}`
}

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
  // Off by default like every feature that widens the UNAUTHENTICATED surface:
  // guest links are the only anonymous entry into the app, so an operator has
  // to ask for them. Guest CALLS additionally need CALLS + a LiveKit.
  { key: 'GUESTS', label: 'Guest links — meetings / temp chats without an account', on: false },
  // On by default because that is how the server has always behaved; surfaced
  // because on a public domain it is the only thing standing between "my
  // friends" and "anyone with the URL", and Lite used to offer no way to
  // close sign-ups at all.
  { key: 'OPEN_REGISTRATION', label: 'Open registration — anyone with the address can sign up', on: true },
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
 * Decide which VAPID pair this run should use.
 *
 * `PERSISTENT_SECRETS` below keeps an existing pair only when the caller passes
 * no `vapid` — but BOTH callers (install.mjs, wizard/server.mjs) used to mint a
 * fresh one on every run where push was enabled, which always won. So merely
 * re-running the installer to flip an unrelated feature rotated the keypair,
 * and every browser already subscribed was silently unsubscribed: the push
 * service rejects pushes signed by the new key, and nothing in the UI says so.
 * Keys are now kept unless there are none, or the operator asks to rotate.
 */
export function resolveVapid({ existing = {}, subject = '', rotate = false } = {}) {
  const havePair = Boolean(existing.OT_VAPID_PUBLIC_KEY && existing.OT_VAPID_PRIVATE_KEY)
  if (havePair && !rotate) {
    return {
      publicKey: existing.OT_VAPID_PUBLIC_KEY,
      privateKey: existing.OT_VAPID_PRIVATE_KEY,
      subject: normalizeSubject(subject || existing.OT_VAPID_SUBJECT),
      rotated: false,
    }
  }
  return { ...generateVapidKeys(normalizeSubject(subject)), rotated: true }
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
    const host = assertHost('LAN address', opts.host || '192.168.1.50')
    const httpsPort = parsePort('HTTPS port', opts.httpsPort, '8443')
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
    const domain = assertHost('domain', opts.domain || 'chat.example.com')
    // Strip the sub-domain only when there IS one: on an apex domain
    // (example.com) the old blanket strip produced `admin@com`, and Let's
    // Encrypt rejects the registration, so issuance failed with a message
    // pointing at the wrong thing.
    const labels = domain.split('.')
    const registrable = labels.length > 2 ? labels.slice(1).join('.') : domain
    const acmeEmail = assertSingleLine('ACME email', opts.acmeEmail || `admin@${registrable}`).trim()
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
  const httpPort = parsePort('port', opts.httpPort, '8443')
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
    OT_MINIO_BIND: minioBind({ cfg, s3PublicUrl: s3PublicUrl || cfg.s3PublicDefault, minioPort: '9000' }),
    OT_S3_PUBLIC_URL: s3PublicUrl || cfg.s3PublicDefault,
    OT_ENABLE_MEDIA: flags.MEDIA,
    OT_ENABLE_CALLS: flags.CALLS,
    OT_ENABLE_STICKERS: flags.STICKERS,
    OT_ENABLE_GIF: flags.GIF,
    OT_ENABLE_PUSH: flags.PUSH,
    OT_ENABLE_2FA: flags['2FA'],
    OT_ENABLE_GUESTS: flags.GUESTS,
    OT_ENABLE_OPEN_REGISTRATION: flags.OPEN_REGISTRATION,
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
      // A line break in any value would append the rest as further env vars —
      // an operator pasting a multi-line LiveKit secret must not be able to
      // redefine OT_ENABLE_GUESTS by accident (or on purpose).
      .map(([k, v]) => `${k}=${assertSingleLine(k, v)}`)
      .join('\n') +
    '\n'
  )
}

/**
 * Media objects are fetched by the BROWSER, not by the server, so the object
 * store URL has to be reachable from wherever the user is sitting.
 *
 * `http://localhost:9000` is the right answer in local mode and a broken one
 * everywhere else — and it is exactly what an operator ends up with, because
 * the GUI pre-fills it and the field keeps its value when the mode changes.
 * The result is an install that looks healthy while every photo, voice message
 * and sticker resolves to a port on the viewer's own machine.
 *
 * Blank stays allowed: both installers offer "leave it blank and fill it in
 * later", and an empty value is at least honest about being unset.
 *
 * @returns a human-readable problem, or `null` when the value is usable.
 */
export function s3UrlProblem({ cfg, flags = {}, s3PublicUrl = '' }) {
  const wantsObjects = flags.MEDIA === '1' || flags.STICKERS === '1'
  const value = String(s3PublicUrl || '').trim()
  if (!wantsObjects || !value || cfg.mode === 'local') return null
  let host
  try {
    host = new URL(value).hostname
  } catch {
    return `the object store URL is not a valid URL: ${JSON.stringify(value)}`
  }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    return (
      `the object store URL points at ${host}, which only works on this machine — ` +
      `in ${cfg.mode} mode every other device would fail to load media. ` +
      `Enter the address browsers will use, or leave it blank to fill in later.`
    )
  }
  return null
}

/**
 * Where the bundled MinIO's port is published.
 *
 * It speaks plain HTTP with the root credentials from `.env.lite`, and it was
 * published on 0.0.0.0 in every mode that is not `local` — so a self-host on a
 * public domain put an unencrypted object store on the open internet, while the
 * installer only warned that browsers could not reach it over HTTPS.
 *
 * It only needs to be reachable from outside when the operator pointed browsers
 * straight at this host's own :9000. Anything else — a fronting proxy, a real
 * s3.<domain>, or media turned off — is served over the docker network and the
 * published port can stay on loopback, where a host-level reverse proxy can
 * still reach it.
 */
export function minioBind({ cfg, s3PublicUrl = '', minioPort = '9000' }) {
  const LOOPBACK = '127.0.0.1:'
  if (cfg.mode === 'local') return LOOPBACK // the browser is on this machine
  let u
  try {
    u = new URL(String(s3PublicUrl || ''))
  } catch {
    return LOOPBACK
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const pointsHere = u.hostname === cfg.host && port === String(minioPort)
  return pointsHere ? '' : LOOPBACK
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

/**
 * Write `.env.lite` + `infra/lite/Caddyfile` under `repo`.
 *
 * `.env.lite` holds the DB password, the JWT secret, the TOTP wrapping key and
 * the VAPID private key. Written with the default mode it lands 0644, so on any
 * shared or multi-account host every other local user can read them — and on a
 * re-run the mode of an existing file is not revisited, hence the explicit
 * chmod. Windows has no POSIX mode; the ACL it inherits is the user's own.
 */
export function writeArtifacts(repo, env, caddyfile) {
  const envPath = join(repo, '.env.lite')
  writeFileSync(envPath, renderEnvFile(env), { mode: 0o600 })
  try {
    chmodSync(envPath, 0o600)
  } catch {
    /* best-effort: Windows / exotic filesystems */
  }
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

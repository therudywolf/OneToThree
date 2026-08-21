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
export function buildEnv({
  cfg,
  flags,
  s3PublicUrl = '',
  livekit = {},
  vapid = null,
  existing = {},
  adminUsername = '',
  mediaDriver = '',
}) {
  const driver = resolveMediaDriver({ mediaDriver, existing })
  const lk = resolveLivekit({ cfg, flags, livekit, existing })
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
    // Where media bytes live. `fs` is the default for a new install: no second
    // container, no object-store URL to get wrong, and media that backs up as a
    // directory. `s3` keeps the bundled MinIO for anyone who wants it (or who
    // already has one full of photos -- see resolveMediaDriver).
    OT_MEDIA_DRIVER: driver,
    // Only meaningful on the fs driver, and it must be ABSOLUTE: the web client
    // is same-origin and would cope with a relative URL, but the Android and
    // desktop shells load the page from their own WebView origin and would
    // resolve it against that.
    OT_MEDIA_PUBLIC_URL: driver === 'fs' ? `${cfg.origin}/api` : '',
    OT_MINIO_USER: 'minio',
    OT_MINIO_PASSWORD: hex(20),
    OT_MINIO_PORT: '9000',
    OT_MINIO_BIND:
      driver === 's3'
        ? minioBind({ cfg, s3PublicUrl: s3PublicUrl || cfg.s3PublicDefault, minioPort: '9000' })
        : '127.0.0.1:',
    OT_S3_PUBLIC_URL: driver === 's3' ? s3PublicUrl || cfg.s3PublicDefault : '',
    OT_ENABLE_MEDIA: flags.MEDIA,
    OT_ENABLE_CALLS: flags.CALLS,
    OT_ENABLE_STICKERS: flags.STICKERS,
    OT_ENABLE_GIF: flags.GIF,
    OT_ENABLE_PUSH: flags.PUSH,
    OT_ENABLE_2FA: flags['2FA'],
    OT_ENABLE_GUESTS: flags.GUESTS,
    OT_ENABLE_OPEN_REGISTRATION: flags.OPEN_REGISTRATION,
    // Handle of the account the API promotes to `creator` on boot, while there
    // is no creator yet. Blank is fine — it just leaves the promotion to the
    // psql one-liner the installer prints.
    //
    // Single-line-checked like every other operator-supplied value: `.env.lite`
    // is line-oriented, so a handle carrying a newline would let the GUI wizard
    // append arbitrary variables (the same hole the domain field was fixed for).
    OT_ADMIN_USERNAME: assertSingleLine('admin handle', adminUsername || '').trim(),
    // Without this the API keeps its `origin_safe` default, where
    // /call/config reports `livekit_enabled: false` regardless of the three
    // vars below — and the client takes the WebSocket audio relay without ever
    // asking for an SFU token. A configured LiveKit was simply ignored.
    OT_CALL_MEDIA_MODE: lk.url ? 'self_hosted' : 'origin_safe',
    OT_LIVEKIT_URL: lk.url,
    OT_LIVEKIT_API_KEY: lk.key,
    OT_LIVEKIT_API_SECRET: lk.secret,
    // Server-side address of the SFU's admin API. Differs from the browser URL
    // for the bundled SFU: the browser goes through Caddy on the public origin,
    // this process goes over the container network. Resolving the browser URL
    // from inside the api container would hit the api container's own loopback.
    OT_LIVEKIT_ADMIN_URL: lk.bundled ? 'http://livekit:7880' : '',
    // Published so browsers can send media to the SFU. Signalling rides Caddy on
    // the normal origin; only this one UDP port has to be reachable, and on a
    // public server it also has to be open in the firewall.
    OT_LIVEKIT_UDP_PORT: lk.bundled ? '7882' : '',
    OT_LIVEKIT_BIND: lk.bundled && cfg.mode !== 'local' ? '' : '127.0.0.1:',
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
 * Which media backend this install should use.
 *
 * `fs` for anything new. The interesting case is the RE-RUN: the guide tells
 * operators to re-run the installer to change mode or features, and an install
 * created before the local driver existed has its photos in MinIO. Quietly
 * switching it to `fs` would leave a working stack pointed at an empty
 * directory -- every existing picture gone from the app, none of them gone from
 * the disk, and nothing in any log. So an existing `.env.lite` that never
 * mentioned a driver keeps S3 unless the operator asks otherwise.
 *
 * @param mediaDriver explicit choice (`fs` / `s3`), or '' to decide from state
 * @param existing    the previous `.env.lite`, from {@link readExistingEnv}
 */
export function resolveMediaDriver({ mediaDriver = '', existing = {} } = {}) {
  const explicit = String(mediaDriver || '').trim().toLowerCase()
  if (explicit === 'fs' || explicit === 's3') return explicit
  const previous = String(existing.OT_MEDIA_DRIVER || '').trim().toLowerCase()
  if (previous === 'fs' || previous === 's3') return previous
  return Object.keys(existing).length ? 's3' : 'fs'
}

/**
 * Settle the three LiveKit questions at once: bundled or external, what URL the
 * browser should use, and which keys.
 *
 * Calls were the last thing Lite could not do on its own, and the reason was
 * never the SFU itself — it was that an SFU needs a second hostname, a second
 * certificate and an open UDP range, which is three more things to get wrong.
 * Bundling it removes two of them: signalling shares the existing origin
 * through the reverse proxy, so the only new requirement is one UDP port.
 *
 * Bundling is opt-IN (`livekit.bundled === true`). An empty `livekit` still
 * means what it always meant here -- no SFU, group calls fall back to the
 * encrypted WebSocket relay -- so no existing caller starts a container it did
 * not ask for. Both installers ask the question outright.
 */
export function resolveLivekit({ cfg, flags = {}, livekit = {}, existing = {} } = {}) {
  const off = { bundled: false, url: '', key: '', secret: '' }
  if (flags.CALLS !== '1') return off

  // ws:// on plain-HTTP local mode, wss:// once Caddy is doing TLS. Getting
  // this wrong is a mixed-content block with nothing in the server log.
  const scheme = cfg.origin.startsWith('https://') ? 'wss://' : 'ws://'
  const bundledUrl = `${scheme}${cfg.origin.replace(/^https?:\/\//, '')}/livekit`

  const suppliedUrl = String(livekit.url || '').trim()
  // A supplied URL that is NOT the one this function mints is the operator's
  // own SFU. A supplied URL that IS ours means this value has already been
  // through here (the installer resolves once, then hands the result to
  // buildEnv) -- re-deriving would mint a SECOND random secret for the same
  // install: one in .env.lite, a different one in livekit.yaml, and an SFU that
  // rejects every token the API signs.
  if (suppliedUrl && suppliedUrl !== bundledUrl) {
    return {
      bundled: false,
      url: assertSingleLine('LiveKit URL', suppliedUrl),
      key: assertSingleLine('LiveKit API key', String(livekit.key || '').trim()),
      secret: assertSingleLine('LiveKit API secret', String(livekit.secret || '').trim()),
    }
  }
  if (livekit.bundled !== true) return off

  // Keys, in order of who has the strongest claim: an already-resolved value,
  // then whatever the running SFU has open (rotating that invalidates every
  // token in flight AND stops matching the livekit.yaml the container loaded),
  // then a fresh pair.
  return {
    bundled: true,
    url: bundledUrl,
    key: livekit.key || existing.OT_LIVEKIT_API_KEY || `APIlite${hex(6)}`,
    secret: livekit.secret || existing.OT_LIVEKIT_API_SECRET || hex(32),
  }
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
export function s3UrlProblem({ cfg, flags = {}, s3PublicUrl = '', mediaDriver = 's3' }) {
  // The fs driver has no object store to reach: media is served by the API from
  // the origin the browser is already on.
  if (mediaDriver === 'fs') return null
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

/**
 * Config for the bundled LiveKit SFU.
 *
 * The whole reason calls were never bundled is that an SFU needs media to reach
 * it over UDP, and a container on a bridge network advertises an address the
 * browser cannot use. Two settings decide whether calls work at all:
 *
 *  - **`use_external_ip`** makes LiveKit discover its own public address over
 *    STUN. Correct on a public server, wrong on localhost (there is no public
 *    address, and the discovery just delays startup).
 *  - **`node_ip`** pins the address to advertise instead. That is what makes a
 *    local or LAN install work: the browser is told to send media to
 *    `127.0.0.1:7882` or `192.168.x.y:7882`, which is exactly where the
 *    published port is.
 *
 * A single UDP port (`udp_port`, i.e. mux) rather than a range: one published
 * port, one firewall rule to explain. TURN stays off — the embedded TURN server
 * needs its own certificate to be useful, and a call that cannot get through
 * still falls back to the encrypted WebSocket relay.
 */
export function renderLivekitConfig({ cfg, apiKey, apiSecret }) {
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(cfg.host || ''))
  const lines = [
    '# Generated by the OneToThree Lite installer. Re-run it to change this file.',
    'port: 7880',
    'log_level: info',
    'rtc:',
    '  tcp_port: 7881',
    '  udp_port: 7882',
  ]
  if (cfg.mode === 'domain') {
    lines.push('  use_external_ip: true')
  } else {
    lines.push('  use_external_ip: false')
    lines.push(`  node_ip: ${cfg.mode === 'lan' && isIpv4 ? cfg.host : '127.0.0.1'}`)
  }
  lines.push(
    'turn:',
    '  enabled: false',
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    // The webhook is how a room that empties tells the API to drop the per-call
    // E2EE key. Over the container network, so no TLS and nothing published.
    'webhook:',
    `  api_key: ${apiKey}`,
    '  urls:',
    '    - http://api:8080/api/call/livekit/webhook',
    ''
  )
  return lines.join('\n')
}

/**
 * Per-mode Caddyfile. Caddy requires each block's `{` to end its line.
 *
 * `livekitBundled` adds the one route that lets the SFU share this origin:
 * signalling is plain WebSocket, so proxying it means no second hostname, no
 * second certificate, and no second port to open for the browser. Only the
 * media itself needs its own UDP port.
 */
export function renderCaddyfile(cfg, { livekitBundled = false } = {}) {
  const routes = [
    '\t# Root-level health passthrough (installer + Docker healthcheck).',
    '\thandle /health {',
    '\t\treverse_proxy api:8080',
    '\t}',
    '\t# REST + WebSocket (/api/ws) → the API. reverse_proxy upgrades WS natively.',
    '\thandle /api/* {',
    '\t\treverse_proxy api:8080',
    '\t}',
    ...(livekitBundled
      ? [
          '\t# Bundled LiveKit SFU: signalling only. Media goes straight to UDP 7882.',
          '\thandle /livekit/* {',
          '\t\turi strip_prefix /livekit',
          '\t\treverse_proxy livekit:7880',
          '\t}',
        ]
      : []),
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

/**
 * `docker compose …` args. The one bundled optional service is MinIO, behind
 * the `media` profile — and it is only wanted on the `s3` driver. Omitting the
 * profile on the fs driver is what actually removes the container: with it the
 * stack would still start MinIO, and a stopped-but-present container is exactly
 * the kind of thing an operator later finds and wonders about.
 *
 * `opts.mediaDriver` comes from the env being written (installer) or from the
 * `.env.lite` on disk (backup). Absent, it means an install from before the
 * driver existed, which had MinIO.
 */
export function composeArgs(flags, extra = [], opts = {}) {
  const driver = String(opts.mediaDriver || 's3').trim().toLowerCase()
  const profiles = []
  if (driver === 's3' && (flags.MEDIA === '1' || flags.STICKERS === '1')) profiles.push('media')
  if (opts.livekitBundled) profiles.push('calls')
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
export function writeArtifacts(repo, env, caddyfile, livekitConfig = '') {
  const envPath = join(repo, '.env.lite')
  writeFileSync(envPath, renderEnvFile(env), { mode: 0o600 })
  try {
    chmodSync(envPath, 0o600)
  } catch {
    /* best-effort: Windows / exotic filesystems */
  }
  mkdirSync(join(repo, 'infra', 'lite'), { recursive: true })
  writeFileSync(join(repo, 'infra', 'lite', 'Caddyfile'), caddyfile)
  if (livekitConfig) {
    // It carries the SFU's API secret, so it gets the same 0600 as .env.lite.
    // A world-readable key here mints tokens for any room on this server.
    const lkPath = join(repo, 'infra', 'lite', 'livekit.yaml')
    writeFileSync(lkPath, livekitConfig, { mode: 0o600 })
    try {
      chmodSync(lkPath, 0o600)
    } catch {
      /* best-effort */
    }
  }
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
    // Direct spawn first, shell only as a fallback. `shell: true` on Windows
    // makes Node emit a DEP0190 warning on stderr, which lands in the middle of
    // a prompt and reads like something went wrong -- during the ONE step whose
    // whole job is to reassure. Anything with a real .exe (docker, node) never
    // needs the shell; a .cmd shim still gets it on the retry.
    const attempt = (useShell) =>
      spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: useShell })
    try {
      let r = attempt(false)
      if (r.error && r.error.code === 'ENOENT' && process.platform === 'win32') {
        r = attempt(true)
      }
      if (r.error) return { ok: false, detail: r.error.message || 'not found' }
      const out = (r.stdout || r.stderr || '').trim().split('\n')[0] || ''
      return { ok: r.status === 0, detail: out }
    } catch (e) {
      return { ok: false, detail: e?.message || 'not found' }
    }
  }
  const docker = check('docker', ['--version'])
  // `docker --version` answers from the CLI binary alone and says nothing about
  // whether anything is listening. Docker Desktop not being started is the
  // single most common reason an install fails, and its symptom used to be a
  // wall of compose output at the very END of the wizard -- after every question
  // had been answered. Ask now.
  const daemon = docker.ok
    ? check('docker', ['info', '--format', '{{.ServerVersion}}'])
    : { ok: false, detail: 'docker is not installed' }
  const major = Number(process.versions.node.split('.')[0])
  return {
    docker,
    daemon: {
      ok: daemon.ok,
      detail: daemon.ok
        ? `engine ${daemon.detail}`
        : 'the Docker daemon is not responding — start Docker Desktop (or `sudo systemctl start docker`)',
    },
    compose: check('docker', ['compose', 'version']),
    node: {
      ok: major >= 18,
      detail: major >= 18 ? process.version : `${process.version} — Node 18 or newer is required`,
    },
  }
}

/** Everything preflight checks, in the order a human should read it. */
export const PREFLIGHT_KEYS = ['docker', 'daemon', 'compose', 'node']

/** Where to get each missing prerequisite, per platform. */
export function installHint(key, platform = process.platform) {
  if (key === 'node') return 'https://nodejs.org/ (LTS)'
  if (platform === 'darwin') return 'https://docs.docker.com/desktop/install/mac-install/'
  if (platform === 'win32') return 'https://docs.docker.com/desktop/install/windows-install/'
  return 'https://docs.docker.com/engine/install/'
}

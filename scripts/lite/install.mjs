#!/usr/bin/env node
/**
 * OneToThree **Lite** installer — a guided setup that stands up your own
 * encrypted messenger anywhere (localhost / LAN / a public domain), with the
 * features you want turned on. No prior config needed.
 *
 *   node scripts/lite/install.mjs
 *
 * It asks: deployment mode (local http / public https), host/domain, and which
 * features to enable (checkboxes); then generates secrets, writes `.env.lite`
 * and `infra/lite/Caddyfile`, and (optionally) launches the stack.
 *
 * See docs/guides/LITE.md and docs/project/ROADMAP_SELFHOST_LITE.md.
 */
import { createInterface } from 'node:readline/promises'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rl = createInterface({ input: process.stdin, output: process.stdout })
const hex = (n) => randomBytes(n).toString('hex')
const q = async (prompt, def) => {
  const a = (await rl.question(`  ${prompt}${def != null ? ` [${def}]` : ''}: `)).trim()
  return a || (def ?? '')
}
const yn = async (prompt, def = true) => {
  const a = (await q(`${prompt} (${def ? 'Y/n' : 'y/N'})`, '')).toLowerCase()
  if (!a) return def
  return /^(y|yes|д|да)/.test(a)
}
const line = (s = '') => process.stdout.write(s + '\n')

async function main() {
  line('\n=== OneToThree Lite — installer ===\n')

  // ── Mode ──────────────────────────────────────────────────────────────────
  // The app is E2EE and uses Web Crypto (crypto.subtle), which the browser only
  // exposes in a SECURE CONTEXT: HTTPS, or plain HTTP on `localhost`. So plain
  // HTTP works on this machine but NOT over a LAN IP — the three modes below make
  // that explicit instead of silently producing a broken (crypto-less) instance.
  line('Deployment mode:')
  line('  1) No domain — this machine only  (http://localhost — everything works, zero setup)')
  line('  2) No domain — LAN / other devices (self-signed HTTPS — needed so E2EE works off-box)')
  line('  3) Domain — public server         (automatic HTTPS via Let\'s Encrypt)')
  const modeChoice = await q('Choose', '1')
  const mode = modeChoice === '3' ? 'domain' : modeChoice === '2' ? 'lan' : 'local'
  line('')

  let origin, httpPort, httpsPort, nodeEnv, cookieSecure, domain = '', acmeEmail = '', s3PublicDefault, host = 'localhost'
  if (mode === 'local') {
    // localhost is a secure context, so crypto.subtle works over plain HTTP — but
    // only here. Intentionally localhost-only; pick mode 2 for other devices.
    httpPort = await q('Port', '8443')
    httpsPort = String(Number(httpPort) + 1) // idle in local mode
    origin = `http://localhost:${httpPort}`
    nodeEnv = 'development'
    cookieSecure = '0'
    // localhost:9000 is same-scheme + secure-context → media works with no extra setup.
    s3PublicDefault = 'http://localhost:9000'
  } else if (mode === 'lan') {
    line('Reachable from phones / other PCs on your network — WITHOUT a domain.')
    line('HTTPS is mandatory (E2EE crypto needs a secure context); Caddy serves a')
    line('self-signed cert. Browsers show a one-time warning — accept it (or install')
    line('Caddy\'s local CA to silence it and enable media). See docs/guides/LITE.md.')
    host = await q('This machine\'s LAN address (IP like 192.168.1.50, or a hostname)', '192.168.1.50')
    httpsPort = await q('HTTPS port', '8443')
    httpPort = String(Number(httpsPort) + 1) // idle; HTTPS is the one you use
    origin = `https://${host}:${httpsPort}`
    nodeEnv = 'production'
    cookieSecure = '1'
    // Media over self-signed HTTPS needs the CA trusted / MinIO fronted — no safe default.
    s3PublicDefault = ''
  } else {
    domain = await q('Your domain (A record → this server)', 'chat.example.com')
    acmeEmail = await q('Email for Let\'s Encrypt (renewal notices)', `admin@${domain.replace(/^[^.]+\./, '')}`)
    httpPort = '80'
    httpsPort = '443'
    origin = `https://${domain}`
    nodeEnv = 'production'
    cookieSecure = '1'
    // No default in domain mode: bundled MinIO is only on :9000 (no TLS, not behind
    // Caddy), so `https://s3.<domain>` would look plausible but not resolve → media
    // silently fails. Force a conscious choice (see below).
    s3PublicDefault = ''
  }
  line('')

  // ── Features (checkbox-style toggle) ────────────────────────────────────────
  const features = [
    { key: 'MEDIA', label: 'Media — photos / voice / video / files', on: true },
    { key: 'CALLS', label: 'Calls — voice / video (external LiveKit)', on: false },
    { key: 'STICKERS', label: 'Stickers (import + create your own)', on: true },
    { key: 'GIF', label: 'GIF search (Tenor / Giphy)', on: true },
    { key: 'PUSH', label: 'Push notifications (Web Push)', on: false },
    { key: '2FA', label: 'Two-factor auth (TOTP)', on: true },
  ]
  line('Features — type numbers to toggle, then press Enter to confirm:')
  for (;;) {
    line('')
    features.forEach((f, i) => line(`  [${f.on ? 'x' : ' '}] ${i + 1}) ${f.label}`))
    const sel = (await q('\n  Toggle #(s) or Enter to confirm', '')).trim()
    if (!sel) break
    for (const tok of sel.split(/[\s,]+/)) {
      const i = Number(tok) - 1
      if (features[i]) features[i].on = !features[i].on
    }
  }
  const isOn = (k) => features.find((f) => f.key === k)?.on ? '1' : '0'
  line('')

  // Media needs a browser-reachable object store.
  let s3PublicUrl = ''
  if (isOn('MEDIA') === '1') {
    if (mode === 'domain') {
      line('⚠ Media on a public domain needs an object store the BROWSER can reach over HTTPS.')
      line('  Lite publishes MinIO on :9000 only (no TLS, not behind Caddy). Front it with your')
      line('  own s3.<domain> and enter that URL, or leave blank to fill in later / turn media')
      line('  off — otherwise uploads/downloads will fail. See docs/guides/LITE.md.')
    } else if (mode === 'lan') {
      line('⚠ On self-signed HTTPS, the browser blocks media fetches to MinIO unless that')
      line('  endpoint is also trusted-HTTPS. Text/chat works after accepting the cert; for')
      line('  media, install Caddy\'s local CA (or front MinIO with a trusted cert) and enter')
      line('  its https URL — or leave blank / turn media off. See docs/guides/LITE.md.')
    }
    s3PublicUrl = await q('Public URL of the object store (MinIO) the browser will reach', s3PublicDefault)
    line('')
  }

  // Calls need a reachable LiveKit SFU. Lite does not bundle one (it needs coturn
  // + open UDP ports); point it at a LiveKit you run, or leave blank to fill in
  // .env.lite later. The API issues the URL + token to clients at call time.
  let livekitUrl = '', livekitKey = '', livekitSecret = ''
  if (isOn('CALLS') === '1') {
    line('Calls need a LiveKit server (not bundled — see docs/guides/LITE.md).')
    livekitUrl = await q('LiveKit WS URL (e.g. wss://livekit.example.com) — blank to set later', '')
    if (livekitUrl) {
      livekitKey = await q('LiveKit API key', '')
      livekitSecret = await q('LiveKit API secret', '')
    }
    line('')
  }

  // ── Secrets + .env.lite ─────────────────────────────────────────────────────
  const env = {
    OT_MODE: mode,
    OT_ORIGIN: origin,
    OT_HTTP_PORT: httpPort,
    OT_HTTPS_PORT: httpsPort,
    // In `lan` mode Caddy listens on the HTTPS port itself (so the self-signed
    // site address host:port matches 1:1); local/domain keep the standard 443.
    OT_HTTPS_CONTAINER_PORT: mode === 'lan' ? httpsPort : '443',
    OT_NODE_ENV: nodeEnv,
    OT_COOKIE_SECURE: cookieSecure,
    OT_DB_PASSWORD: hex(16),
    OT_JWT_SECRET: hex(32),
    OT_TOTP_WRAP_KEY: hex(32),
    OT_MINIO_USER: 'minio',
    OT_MINIO_PASSWORD: hex(20),
    OT_MINIO_PORT: '9000',
    OT_S3_PUBLIC_URL: s3PublicUrl || s3PublicDefault,
    OT_ENABLE_MEDIA: isOn('MEDIA'),
    OT_ENABLE_CALLS: isOn('CALLS'),
    OT_ENABLE_STICKERS: isOn('STICKERS'),
    OT_ENABLE_GIF: isOn('GIF'),
    OT_ENABLE_PUSH: isOn('PUSH'),
    OT_ENABLE_2FA: isOn('2FA'),
    // Calls: external LiveKit (blank until you provide one). API-only — no rebuild.
    OT_LIVEKIT_URL: livekitUrl,
    OT_LIVEKIT_API_KEY: livekitKey,
    OT_LIVEKIT_API_SECRET: livekitSecret,
  }
  const envPath = join(REPO, '.env.lite')
  writeFileSync(
    envPath,
    '# Generated by scripts/lite/install.mjs — contains secrets, do not commit.\n' +
      Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  )

  // ── Caddyfile (per mode) ────────────────────────────────────────────────────
  // Caddy requires each block's `{` to end its line — inline `{ … }` is rejected.
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
  const caddyfile =
    mode === 'local'
      ? `{\n\tauto_https off\n}\n\n:80 {\n${routes}\n}\n`
      : mode === 'lan'
        // Self-signed HTTPS via Caddy's internal CA. The site address needs the
        // host (so Caddy can mint an internal cert for it) AND the exact port
        // Caddy listens on / is published 1:1 (OT_HTTPS_CONTAINER_PORT), so the
        // browser's host:port matches the site. Makes the LAN origin a secure
        // context → E2EE works off the local machine.
        ? `{\n\tauto_https disable_redirects\n}\n\nhttps://${host}:${httpsPort} {\n\ttls internal\n${routes}\n}\n`
        : `{\n\temail ${acmeEmail}\n}\n\n${domain} {\n${routes}\n}\n`
  mkdirSync(join(REPO, 'infra', 'lite'), { recursive: true })
  writeFileSync(join(REPO, 'infra', 'lite', 'Caddyfile'), caddyfile)

  // ── Compose command ─────────────────────────────────────────────────────────
  // Only `media` (MinIO) is a bundled optional service. Calls use an external
  // LiveKit wired via env (OT_LIVEKIT_*), so there is no `calls` compose profile.
  const profiles = []
  if (isOn('MEDIA') === '1' || isOn('STICKERS') === '1') profiles.push('media')
  const composeArgs = [
    'compose', '--env-file', '.env.lite', '-f', 'docker-compose.lite.yml',
    ...profiles.flatMap((p) => ['--profile', p]),
    'up', '-d', '--build',
  ]

  line('✓ Wrote .env.lite (secrets) and infra/lite/Caddyfile')
  line('')
  line('Summary:')
  line(`  mode     ${mode}   →   ${origin}`)
  line(`  features ${features.filter((f) => f.on).map((f) => f.key).join(', ') || '(none)'}`)
  line(`  start    docker ${composeArgs.join(' ')}`)
  line('')

  const runNow = await yn('Start it now?', true)
  rl.close()
  if (!runNow) {
    line(`\nWhen ready:\n  docker ${composeArgs.join(' ')}\n\nThen open ${origin}\n`)
    return
  }
  line('\nBuilding + starting (first run pulls images + builds — a few minutes)…\n')
  const r = spawnSync('docker', composeArgs, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    line('\n[!] docker compose failed. Fix the issue and re-run:\n  docker ' + composeArgs.join(' '))
    process.exit(r.status ?? 1)
  }
  if (mode === 'lan') {
    line('\n(Self-signed HTTPS: your browser will warn once — accept it to proceed. To')
    line(' silence it + enable media, install Caddy\'s local CA on each device.)')
  }
  line(`\n✓ Up. Open ${origin} , register the first account, then make yourself owner:`)
  line(`  docker compose --env-file .env.lite -f docker-compose.lite.yml exec db \\`)
  line(`    psql -U forest -d forest -c "UPDATE users SET user_group='creator', role='admin' WHERE username='YOURNAME';"`)
}

main().catch((e) => {
  try { rl.close() } catch { /* ignore */ }
  console.error('\n[!] installer error:', e?.message || e)
  process.exit(1)
})

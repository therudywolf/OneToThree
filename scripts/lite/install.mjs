#!/usr/bin/env node
/**
 * OneToThree **Lite** installer (text CLI) — a guided setup that stands up your
 * own encrypted messenger anywhere (localhost / LAN / a public domain), with the
 * features you want turned on. No prior config needed.
 *
 *   node scripts/lite/install.mjs
 *
 * Prefer the graphical version with real checkboxes:
 *   npm run lite:gui        (or: node scripts/lite/wizard/server.mjs)
 *
 * Both share scripts/lite/lite-core.mjs, so they produce identical artifacts.
 * See docs/guides/LITE.md and docs/project/ROADMAP_SELFHOST_LITE.md.
 */
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  FEATURES,
  computeModeConfig,
  buildEnv,
  renderCaddyfile,
  writeArtifacts,
  composeArgs,
  resolveVapid,
  s3UrlProblem,
  readExistingEnv,
} from './lite-core.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rl = createInterface({ input: process.stdin, output: process.stdout })
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
  line('\n=== OneToThree Lite — installer ===')
  line('(Tip: `npm run lite:gui` opens the same setup with real checkboxes in a browser.)\n')

  // ── Mode ──────────────────────────────────────────────────────────────────
  line('Deployment mode:')
  line('  1) No domain — this machine only  (http://localhost — everything works, zero setup)')
  line('  2) No domain — LAN / other devices (self-signed HTTPS — needed so E2EE works off-box)')
  line('  3) Domain — public server         (automatic HTTPS via Let\'s Encrypt)')
  const modeChoice = await q('Choose', '1')
  const mode = modeChoice === '3' ? 'domain' : modeChoice === '2' ? 'lan' : 'local'
  line('')

  const opts = {}
  if (mode === 'local') {
    opts.httpPort = await q('Port', '8443')
  } else if (mode === 'lan') {
    line('Reachable from phones / other PCs on your network — WITHOUT a domain.')
    line('HTTPS is mandatory (E2EE crypto needs a secure context); Caddy serves a')
    line('self-signed cert. Browsers show a one-time warning — accept it (or install')
    line('Caddy\'s local CA to silence it and enable media). See docs/guides/LITE.md.')
    opts.host = await q('This machine\'s LAN address (IP like 192.168.1.50, or a hostname)', '192.168.1.50')
    opts.httpsPort = await q('HTTPS port', '8443')
  } else {
    opts.domain = await q('Your domain (A record → this server)', 'chat.example.com')
    opts.acmeEmail = await q('Email for Let\'s Encrypt (renewal notices)', '')
  }
  const cfg = computeModeConfig(mode, opts)
  line('')

  // ── Features (checkbox-style toggle) ────────────────────────────────────────
  const features = FEATURES.map((f) => ({ ...f }))
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
  const flags = Object.fromEntries(features.map((f) => [f.key, f.on ? '1' : '0']))
  line('')

  // Media needs a browser-reachable object store.
  let s3PublicUrl = ''
  if (flags.MEDIA === '1') {
    if (mode === 'domain') {
      line('⚠ Media on a public domain needs an object store the BROWSER can reach over HTTPS.')
      line('  Lite publishes MinIO on :9000 only (no TLS, not behind Caddy). Front it with your')
      line('  own s3.<domain> and enter that URL, or leave blank to fill in later / turn media off.')
    } else if (mode === 'lan') {
      line('⚠ On self-signed HTTPS, the browser blocks media fetches to MinIO unless that')
      line('  endpoint is also trusted-HTTPS. Install Caddy\'s local CA and enter its https URL —')
      line('  or leave blank / turn media off. See docs/guides/LITE.md.')
    }
    // Re-ask on a value that cannot work: a localhost object store outside
    // local mode leaves every remote device with broken media, and the install
    // otherwise looks completely healthy. Blank is still accepted on purpose.
    for (;;) {
      s3PublicUrl = await q(
        'Public URL of the object store (MinIO) the browser will reach',
        cfg.s3PublicDefault
      )
      const problem = s3UrlProblem({ cfg, flags, s3PublicUrl })
      if (!problem) break
      line(`  ⚠ ${problem}`)
    }
    line('')
  }

  // Calls need an external LiveKit SFU (not bundled).
  const livekit = {}
  if (flags.CALLS === '1') {
    line('Calls need a LiveKit server (not bundled — see docs/guides/LITE.md).')
    livekit.url = await q('LiveKit WS URL (e.g. wss://livekit.example.com) — blank to set later', '')
    if (livekit.url) {
      livekit.key = await q('LiveKit API key', '')
      livekit.secret = await q('LiveKit API secret', '')
    }
    line('')
  }

  // Re-running the installer must not mint new DB / JWT / TOTP / MinIO secrets:
  // the volumes still hold the originals, so a fresh set means the stack comes
  // back up with `password authentication failed`.
  const existing = readExistingEnv(REPO)

  // Push: keep the pair browsers are already subscribed to; mint one only when
  // there is none. Rotating it here silently kills every existing subscription.
  let vapid = null
  if (flags.PUSH === '1') {
    const subject = await q(
      'Push contact address (mailto: or https:)',
      existing.OT_VAPID_SUBJECT || 'mailto:admin@localhost'
    )
    vapid = resolveVapid({ existing, subject })
    line(
      vapid.rotated
        ? '  ✓ Generated a VAPID keypair for Web Push.'
        : '  ✓ Kept the existing VAPID keypair — already-subscribed browsers keep working.'
    )
    line('')
  }

  // ── Write artifacts ─────────────────────────────────────────────────────────
  const env = buildEnv({ cfg, flags, s3PublicUrl, livekit, vapid, existing })
  if (Object.keys(existing).length) {
    line('  (existing install detected — keeping its database and session secrets)')
  }
  writeArtifacts(REPO, env, renderCaddyfile(cfg))
  const args = composeArgs(flags, ['up', '-d', '--build'])

  line('✓ Wrote .env.lite (secrets) and infra/lite/Caddyfile')
  line('')
  line('Summary:')
  line(`  mode     ${mode}   →   ${cfg.origin}`)
  line(`  features ${features.filter((f) => f.on).map((f) => f.key).join(', ') || '(none)'}`)
  line(`  start    docker ${args.join(' ')}`)
  line('')

  const runNow = await yn('Start it now?', true)
  rl.close()
  if (!runNow) {
    line(`\nWhen ready:\n  docker ${args.join(' ')}\n\nThen open ${cfg.origin}\n`)
    return
  }
  line('\nBuilding + starting (first run pulls images + builds — a few minutes)…\n')
  const r = spawnSync('docker', args, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    line('\n[!] docker compose failed. Fix the issue and re-run:\n  docker ' + args.join(' '))
    process.exit(r.status ?? 1)
  }
  if (mode === 'lan') {
    line('\n(Self-signed HTTPS: your browser will warn once — accept it to proceed. To')
    line(' silence it + enable media, install Caddy\'s local CA on each device.)')
  }
  line(`\n✓ Up. Open ${cfg.origin} , register the first account, then make yourself owner:`)
  line(`  docker compose --env-file .env.lite -f docker-compose.lite.yml exec db \\`)
  line(`    psql -U forest -d forest -c "UPDATE users SET user_group='creator', role='admin' WHERE username='YOURNAME';"`)
}

main().catch((e) => {
  try { rl.close() } catch { /* ignore */ }
  console.error('\n[!] installer error:', e?.message || e)
  process.exit(1)
})

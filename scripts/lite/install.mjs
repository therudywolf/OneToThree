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
 *
 * Presentation lives in ui.mjs and degrades to plain ASCII without colour when
 * the console cannot be trusted with more — a legacy Windows code page, a piped
 * log, a CI runner. The steps are numbered because the two questions every
 * installer is silently asked are "how much is left" and "did I miss something".
 */
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  FEATURES,
  PREFLIGHT_KEYS,
  computeModeConfig,
  buildEnv,
  installHint,
  preflight,
  renderCaddyfile,
  writeArtifacts,
  composeArgs,
  renderLivekitConfig,
  resolveLivekit,
  resolveMediaDriver,
  resolveVapid,
  s3UrlProblem,
  readExistingEnv,
} from './lite-core.mjs'
import { banner, box, bullet, c, checklist, err, hint, kv, line, menu, ok, plain, step, warn } from './ui.mjs'

/**
 * `OT_LITE_REPO` points the installer at a throwaway root. It exists for the
 * end-to-end test: writing `.env.lite` into the real checkout mid-test would
 * overwrite a working install's secrets. The wizard has had the same escape
 * hatch since it was written.
 */
const REPO = process.env.OT_LITE_REPO
  ? resolve(process.env.OT_LITE_REPO)
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rl = createInterface({ input: process.stdin, output: process.stdout })

const q = async (prompt, def) => {
  const suffix = def != null && def !== '' ? c.dim(` [${def}]`) : ''
  // Through `plain` like every other string: the prompt is written by readline,
  // not by ui.line, so it would otherwise be the one place an em dash survives
  // onto a console that cannot render it.
  const a = (await rl.question(plain(`  ${prompt}${suffix}: `))).trim()
  return a || (def ?? '')
}
const yn = async (prompt, def = true) => {
  const a = (await q(`${prompt} ${c.dim(def ? '(Y/n)' : '(y/N)')}`, '')).toLowerCase()
  if (!a) return def
  return /^(y|yes|д|да)/.test(a)
}
/** Ask for one of `1..n`, defaulting to `def`. */
const pick = async (n, def = '1') => {
  for (;;) {
    const a = await q('Choose', def)
    const i = Number(a)
    if (Number.isInteger(i) && i >= 1 && i <= n) return i
    warn(`enter a number from 1 to ${n}`)
  }
}

/** Total steps shown in the headers — kept honest by STEPS.length. */
const STEPS = [
  'Checking what this machine has',
  'Where people will reach it',
  'What the messenger can do',
  'Where photos and voice notes live',
  'Calls',
  'Push notifications',
  'The first administrator',
  'Review and start',
]
const N = STEPS.length
let stepNo = 0
const nextStep = (title) => step(++stepNo, N, title ?? STEPS[stepNo - 1])
/** Advance the counter for a step that does not apply this run. */
const skipStep = (why) => {
  stepNo++
  line(`${c.dim(`Step ${stepNo}/${N}`)}  ${c.dim(`${STEPS[stepNo - 1]} — ${why}`)}`)
}

async function main() {
  banner(
    'OneToThree Lite — installer',
    'Your own end-to-end encrypted messenger, in one guided setup.'
  )
  hint('A graphical version of this same setup: npm run lite:gui')

  /* ── 1. Preflight ───────────────────────────────────────────────────────── */
  nextStep()
  const pf = preflight()
  const LABELS = {
    docker: 'Docker',
    daemon: 'Docker is running',
    compose: 'Docker Compose v2',
    node: 'Node.js',
  }
  let blocked = false
  for (const key of PREFLIGHT_KEYS) {
    const r = pf[key]
    if (r.ok) {
      ok(`${LABELS[key]}  ${c.dim(r.detail)}`)
    } else {
      blocked = true
      err(`${LABELS[key]} — ${r.detail}`)
      hint(installHint(key))
    }
  }
  if (blocked) {
    line()
    // Stopping here is the whole point of asking first: the alternative is
    // seven answered questions followed by a wall of compose errors.
    box(
      [
        c.bold('Nothing was changed.'),
        'Install what is missing above, then run this again:',
        c.cyan('  node scripts/lite/install.mjs'),
      ],
      { color: 'red' }
    )
    rl.close()
    process.exit(1)
  }

  const existing = readExistingEnv(REPO)
  if (Object.keys(existing).length) {
    line()
    warn('An existing install was found in this folder.')
    hint('Its database password, session secret and 2FA key are kept as they are —')
    hint('changing them would lock the running stack out of its own volumes.')
  }

  /* ── 2. Mode ────────────────────────────────────────────────────────────── */
  nextStep()
  menu([
    {
      label: 'Just this computer',
      detail: 'http://localhost — nothing to configure, works immediately.',
      recommended: true,
    },
    {
      label: 'Other devices on my network (no domain)',
      detail: 'Phones and PCs on the same Wi-Fi. Self-signed HTTPS: one browser warning to accept.',
    },
    {
      label: 'A public domain',
      detail: 'Anyone on the internet. Real HTTPS certificates, issued automatically.',
    },
  ])
  const modeChoice = await pick(3, '1')
  const mode = modeChoice === 3 ? 'domain' : modeChoice === 2 ? 'lan' : 'local'

  const opts = {}
  line()
  if (mode === 'local') {
    opts.httpPort = await q('Port to use on this machine', '8443')
  } else if (mode === 'lan') {
    hint('Encryption needs a secure context, so HTTPS is required even on a LAN.')
    hint("Caddy issues a self-signed certificate; browsers warn once — accept it.")
    hint("(Installing Caddy's local CA on each device silences the warning.)")
    line()
    opts.host = await q("This machine's address on the network (e.g. 192.168.1.50)", '192.168.1.50')
    opts.httpsPort = await q('HTTPS port', '8443')
  } else {
    hint('The domain needs an A record already pointing at this server, or the')
    hint('certificate cannot be issued.')
    line()
    opts.domain = await q('Domain', 'chat.example.com')
    opts.acmeEmail = await q("Email for certificate renewal notices (optional)", '')
  }
  let cfg
  try {
    cfg = computeModeConfig(mode, opts)
  } catch (e) {
    line()
    err(e?.message || String(e))
    rl.close()
    process.exit(1)
  }
  line()
  ok(`People will open ${c.bold(cfg.origin)}`)

  /* ── 3. Features ────────────────────────────────────────────────────────── */
  nextStep()
  hint('Anything switched off here has no interface, no API and no container.')
  const features = FEATURES.map((f) => ({ ...f }))
  for (;;) {
    line()
    checklist(features)
    line()
    const sel = (await q(`Type a number to flip it, or press ${c.bold('Enter')} to continue`, '')).trim()
    if (!sel) break
    let touched = false
    for (const tok of sel.split(/[\s,]+/)) {
      const i = Number(tok) - 1
      if (features[i]) {
        features[i].on = !features[i].on
        touched = true
      }
    }
    if (!touched) warn('that was not one of the numbers above')
  }
  const flags = Object.fromEntries(features.map((f) => [f.key, f.on ? '1' : '0']))

  /* ── 4. Media storage ───────────────────────────────────────────────────── */
  const wantsObjects = flags.MEDIA === '1' || flags.STICKERS === '1'
  let mediaDriver = resolveMediaDriver({ existing })
  let s3PublicUrl = ''
  if (!wantsObjects) {
    skipStep('media and stickers are off')
    mediaDriver = 'fs'
  } else {
    nextStep()
    const previous = resolveMediaDriver({ existing })
    if (previous === 's3' && Object.keys(existing).length) {
      warn('This install already stores media in the bundled MinIO.')
      hint('Switching now leaves those files where they are — the app would stop')
      hint('finding them. Keep MinIO unless you have moved the files yourself.')
      line()
    }
    menu([
      {
        label: 'On this server, as ordinary files',
        detail: 'No extra container, nothing else to configure. Back up with a directory copy.',
        recommended: previous !== 's3',
      },
      {
        label: 'In the bundled MinIO object store',
        detail: 'A second container, and a public URL the browser must be able to reach.',
        recommended: previous === 's3',
      },
    ])
    const choice = await pick(2, previous === 's3' ? '2' : '1')
    mediaDriver = choice === 2 ? 's3' : 'fs'

    if (mediaDriver === 'fs') {
      line()
      ok(`Media will be served by the app itself, from ${c.bold(`${cfg.origin}/api`)}`)
      hint('Links are signed and expire, exactly like the object-store ones.')
    } else {
      line()
      if (mode === 'domain') {
        warn('MinIO is published on plain :9000 and is not behind the HTTPS proxy.')
        hint('Put your own s3.<domain> in front of it and enter that URL here.')
      } else if (mode === 'lan') {
        warn('On self-signed HTTPS the browser blocks media fetched over plain HTTP.')
        hint("Install Caddy's local CA and enter an https URL, or leave this blank.")
      }
      // Re-ask on a value that cannot work: a localhost object store outside
      // local mode leaves every remote device with broken media, and the
      // install otherwise looks completely healthy. Blank is still accepted.
      for (;;) {
        s3PublicUrl = await q(
          'URL the browser will use to reach the object store',
          cfg.s3PublicDefault
        )
        const problem = s3UrlProblem({ cfg, flags, s3PublicUrl, mediaDriver })
        if (!problem) break
        warn(problem)
      }
    }
  }

  /* ── 5. Calls ───────────────────────────────────────────────────────────── */
  let livekit = {}
  if (flags.CALLS !== '1') {
    skipStep('calls are off')
  } else {
    nextStep()
    hint('One-to-one calls need nothing extra: the audio goes over the same')
    hint('encrypted connection the messages use.')
    hint('Group calls need a media server (an SFU) to mix the streams.')
    line()
    menu([
      {
        label: 'Use the bundled one',
        detail: 'One more container. Opens one UDP port (7882); everything else shares this address.',
        recommended: true,
      },
      { label: 'Point at a LiveKit I already run', detail: 'You supply its URL and API keys.' },
      { label: 'One-to-one calls only', detail: 'No group calls, no extra container.' },
    ])
    const choice = await pick(3, '1')
    line()
    if (choice === 2) {
      livekit.url = await q('LiveKit WebSocket URL (e.g. wss://livekit.example.com)', '')
      if (livekit.url) {
        livekit.key = await q('LiveKit API key', '')
        livekit.secret = await q('LiveKit API secret', '')
      }
    } else {
      livekit.bundled = choice === 1
    }
    livekit = resolveLivekit({ cfg, flags, livekit, existing })
    line()
    if (livekit.bundled) {
      ok('Group calls will use the bundled media server.')
      if (mode === 'domain') {
        warn('Open UDP port 7882 on this server, or group calls will connect and stay silent.')
      } else if (mode === 'lan') {
        hint('Other devices reach the media on UDP 7882 — allow it through this')
        hint('machine\'s firewall if calls connect but nobody can be heard.')
      }
    } else if (livekit.url) {
      ok('Group calls will use that server; one-to-one keeps the direct path.')
    } else {
      ok('One-to-one calls only.')
    }
  }

  /* ── 6. Push ────────────────────────────────────────────────────────────── */
  let vapid = null
  if (flags.PUSH !== '1') {
    skipStep('push is off')
  } else {
    nextStep()
    hint('Web Push needs a contact address in each notification it signs. It is')
    hint('never shown to your users — only to the browser vendor push service.')
    line()
    const subject = await q(
      'Contact address (mailto: or https:)',
      existing.OT_VAPID_SUBJECT || 'mailto:admin@localhost'
    )
    vapid = resolveVapid({ existing, subject })
    line()
    if (vapid.rotated) ok('Generated a signing keypair for push.')
    else ok('Kept the existing keypair — already-subscribed browsers keep working.')
  }

  /* ── 7. First admin ─────────────────────────────────────────────────────── */
  nextStep()
  hint('The app has no built-in admin account. Name a handle here and the server')
  hint('promotes it the first time it sees it — you still register normally.')
  if (flags.OPEN_REGISTRATION === '1' && mode === 'domain') {
    line()
    warn('Sign-ups are open on a public address.')
    hint('Register this handle BEFORE anyone else can: promotion matches on the')
    hint('name, so whoever claims it first would become the owner.')
  }
  line()
  const adminUsername = await q(
    'Handle of the first administrator (blank to skip)',
    existing.OT_ADMIN_USERNAME || ''
  )

  /* ── 8. Review ──────────────────────────────────────────────────────────── */
  nextStep()
  const env = buildEnv({
    cfg,
    flags,
    s3PublicUrl,
    livekit,
    vapid,
    existing,
    adminUsername,
    mediaDriver,
  })
  writeArtifacts(
    REPO,
    env,
    renderCaddyfile(cfg, { livekitBundled: Boolean(livekit.bundled) }),
    livekit.bundled
      ? renderLivekitConfig({ cfg, apiKey: livekit.key, apiSecret: livekit.secret })
      : ''
  )
  const args = composeArgs(flags, ['up', '-d', '--build'], {
    mediaDriver,
    livekitBundled: Boolean(livekit.bundled),
  })

  const on = features.filter((f) => f.on).map((f) => f.key)
  kv([
    ['address', c.bold(cfg.origin)],
    ['mode', mode],
    ['features', on.join(', ') || c.dim('(none)')],
    [
      'media',
      wantsObjects
        ? mediaDriver === 'fs'
          ? 'files on this server'
          : `MinIO${s3PublicUrl ? ` at ${s3PublicUrl}` : ' (URL not set yet)'}`
        : c.dim('off'),
    ],
    [
      'calls',
      flags.CALLS !== '1'
        ? c.dim('off')
        : livekit.bundled
          ? 'bundled media server (UDP 7882)'
          : livekit.url
            ? `external: ${livekit.url}`
            : 'one-to-one only',
    ],
    ['admin', adminUsername || c.dim('(set later)')],
  ])
  line()
  ok('Wrote .env.lite and infra/lite/Caddyfile')
  hint('.env.lite holds every secret this install has. Do not commit it.')
  line()

  const runNow = await yn('Build and start it now?', true)
  rl.close()
  if (!runNow) {
    line()
    box(
      [
        c.bold('Ready when you are.'),
        '',
        c.cyan(`  docker ${args.join(' ')}`),
        '',
        `Then open ${c.bold(cfg.origin)}`,
      ],
      { color: 'cyan' }
    )
    return
  }

  line()
  bullet('Building. The first run pulls images and compiles the app — a few minutes.')
  line(c.dim(`  $ docker ${args.join(' ')}`))
  line()
  const r = spawnSync('docker', args, {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    line()
    box(
      [
        c.bold('docker compose did not finish.'),
        'Your answers are saved in .env.lite — fix the problem above and re-run:',
        c.cyan(`  docker ${args.join(' ')}`),
      ],
      { color: 'red' }
    )
    process.exit(r.status ?? 1)
  }

  /* ── Done ───────────────────────────────────────────────────────────────── */
  const done = [c.bold('Running.'), '', `Open  ${c.bold(cfg.origin)}`, '']
  if (mode === 'lan') {
    done.push(
      c.yellow('Your browser will warn about the certificate once — accept it.'),
      ''
    )
  }
  if (adminUsername) {
    done.push(
      `Register as ${c.bold(adminUsername)}, then restart the API once:`,
      c.cyan('  docker compose --env-file .env.lite -f docker-compose.lite.yml restart api'),
      c.dim('  (it promotes that account to owner on boot)')
    )
  } else {
    done.push(
      'Register the first account, then make it the owner:',
      // Deliberately one very long line: a backslash continuation is bash syntax
      // and does not survive a copy-paste into PowerShell or cmd, which is where
      // half of these installs run.
      c.cyan(
        '  docker compose --env-file .env.lite -f docker-compose.lite.yml exec db ' +
          `psql -U forest -d forest -c "UPDATE users SET user_group='creator', role='admin' WHERE username='YOURNAME';"`
      )
    )
  }
  line()
  box(done, { color: 'green' })
  line()
  kv(
    [
      ['back up', c.cyan('npm run lite:backup')],
      ['stop', c.cyan('docker compose --env-file .env.lite -f docker-compose.lite.yml down')],
      ['change settings', c.cyan('re-run this installer')],
      ['docs', c.dim('docs/guides/LITE.md')],
    ],
    '  '
  )
  line()
}

main().catch((e) => {
  try {
    rl.close()
  } catch {
    /* ignore */
  }
  line()
  err(`installer error: ${e?.message || e}`)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * OneToThree Lite — graphical first-run wizard (Sprint 5).
 *
 * A tiny zero-dependency HTTP server (Node built-ins only) that serves a
 * checkbox UI, then generates `.env.lite` + `infra/lite/Caddyfile` and runs
 * `docker compose` — all on this machine. Cross-platform (Windows / macOS /
 * Linux); nothing but Node + Docker required. Binds to 127.0.0.1 only, so the
 * control surface is never exposed to the network.
 *
 *   npm run lite:gui            # opens http://127.0.0.1:4173
 *   node scripts/lite/wizard/server.mjs [--port 4173] [--no-open]
 *
 * Shares scripts/lite/lite-core.mjs with the text CLI, so both produce
 * identical artifacts. See docs/guides/LITE.md.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FEATURES,
  computeModeConfig,
  buildEnv,
  renderCaddyfile,
  writeArtifacts,
  composeArgs,
  resolveVapid,
  s3UrlProblem,
  suggestLanIp,
  preflight,
  readExistingEnv,
  renderLivekitConfig,
  resolveLivekit,
  resolveMediaDriver,
} from '../lite-core.mjs'
import { checkRequest } from './http-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// `OT_LITE_REPO` exists so the wizard can be exercised against a throwaway
// fixture root: writing .env.lite into the real checkout during a test would
// clobber a working install's secrets.
const REPO = process.env.OT_LITE_REPO ? resolve(process.env.OT_LITE_REPO) : join(HERE, '..', '..', '..')
const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 4173
const NO_OPEN = argv.includes('--no-open')

/** State from the last successful /api/generate, consumed by /api/launch + /api/status. */
let lastRun = null // { flags, origin, mode }

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {})
      } catch {
        resolve({})
      }
    })
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    // Loopback binding keeps other machines out; this keeps out the browser on
    // THIS machine, which can otherwise reach the wizard from any open tab.
    const guard = checkRequest({ method: req.method, headers: req.headers, port: PORT })
    if (!guard.ok) return json(res, guard.code, { error: guard.error })

    // ── UI ────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(HERE, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    // ── Preflight (Docker / Compose / Node) ─────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/preflight') {
      return json(res, 200, preflight())
    }

    // ── Defaults for the form ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/defaults') {
      return json(res, 200, {
        features: FEATURES,
        suggestedIp: suggestLanIp(),
        defaults: { localPort: '8443', lanPort: '8443' },
      })
    }

    // ── Generate config (writes .env.lite + Caddyfile; does NOT run docker) ──
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const b = await readBody(req)
      const mode = ['local', 'lan', 'domain'].includes(b.mode) ? b.mode : 'local'
      const flags = Object.fromEntries(
        FEATURES.map((f) => [f.key, b.flags && b.flags[f.key] ? '1' : '0'])
      )
      // A rejected port / host / domain is the operator's typo, not a server
      // fault: answer 400 with the reason so the form can show it, instead of
      // an opaque 500 (or, as before, an .env.lite carrying `NaN`).
      let cfg
      try {
        cfg = computeModeConfig(mode, b.opts || {})
      } catch (e) {
        return json(res, 400, { error: e?.message || 'invalid configuration' })
      }
      // Same as the text installer: re-running must not mint new DB / JWT /
      // TOTP / MinIO secrets, or the existing volumes stop authenticating — and
      // must not rotate VAPID either, or every subscribed browser goes silent.
      const existing = readExistingEnv(REPO)
      const vapid =
        flags.PUSH === '1'
          ? resolveVapid({ existing, subject: b.vapidSubject, rotate: Boolean(b.rotateVapid) })
          : null
      // The form sends 'fs' or 's3'. A caller that sends neither but DOES send
      // an object-store URL means the object store -- that is what every client
      // written before the local driver existed looks like, and reading it as
      // "fs, ignore the URL" would silently drop a setting the operator typed.
      const mediaDriver = resolveMediaDriver({
        mediaDriver: b.mediaDriver || ((b.s3PublicUrl || '').trim() ? 's3' : ''),
        existing,
      })
      const s3PublicUrl = (b.s3PublicUrl || '').trim()
      const s3Problem = s3UrlProblem({ cfg, flags, s3PublicUrl, mediaDriver })
      if (s3Problem) return json(res, 400, { error: s3Problem })

      // Resolved ONCE: the key it settles on is written to two files, and
      // deriving it twice would put a different secret in each.
      let livekit
      try {
        livekit = resolveLivekit({ cfg, flags, livekit: b.livekit || {}, existing })
      } catch (e) {
        return json(res, 400, { error: e?.message || 'invalid LiveKit configuration' })
      }

      let env
      try {
        env = buildEnv({
          cfg,
          flags,
          s3PublicUrl,
          livekit,
          vapid,
          existing,
          // Same knob as the CLI: the API promotes this handle to `creator` on
          // boot while the instance has none. buildEnv single-line-checks it,
          // so a pasted newline is a 400 here, not an injected env line.
          adminUsername: b.adminUsername || '',
          mediaDriver,
        })
        writeArtifacts(
          REPO,
          env,
          renderCaddyfile(cfg, { livekitBundled: livekit.bundled }),
          livekit.bundled
            ? renderLivekitConfig({ cfg, apiKey: livekit.key, apiSecret: livekit.secret })
            : ''
        )
      } catch (e) {
        return json(res, 400, { error: e?.message || 'invalid configuration' })
      }
      const composeOpts = { mediaDriver, livekitBundled: livekit.bundled }
      const upArgs = composeArgs(flags, ['up', '-d', '--build'], composeOpts)
      lastRun = { flags, origin: cfg.origin, mode, ...composeOpts }
      return json(res, 200, {
        ok: true,
        mode,
        origin: cfg.origin,
        enabled: FEATURES.filter((f) => flags[f.key] === '1').map((f) => f.key),
        composeCmd: 'docker ' + upArgs.join(' '),
        envPath: '.env.lite',
        caddyPath: 'infra/lite/Caddyfile',
        vapidGenerated: Boolean(vapid?.rotated),
        vapidKept: Boolean(vapid && !vapid.rotated),
      })
    }

    // ── Launch: docker compose up -d --build, streamed as SSE ───────────────
    if (req.method === 'GET' && url.pathname === '/api/launch') {
      if (!lastRun) return json(res, 409, { error: 'generate config first' })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      const args = composeArgs(lastRun.flags, ['up', '-d', '--build'], {
        mediaDriver: lastRun.mediaDriver,
        livekitBundled: lastRun.livekitBundled,
      })
      send('log', `$ docker ${args.join(' ')}`)
      const child = spawn('docker', args, { cwd: REPO, shell: process.platform === 'win32' })
      const pump = (buf) =>
        String(buf)
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((l) => send('log', l))
      child.stdout.on('data', pump)
      child.stderr.on('data', pump) // compose writes build/progress to stderr
      child.on('error', (e) => {
        send('done', { code: 1, error: e.message })
        res.end()
      })
      child.on('close', (code) => {
        send('done', { code, origin: lastRun.origin, mode: lastRun.mode })
        res.end()
      })
      req.on('close', () => { try { child.kill() } catch { /* ignore */ } })
      return
    }

    // ── Post-install status (containers + health) ───────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!lastRun) return json(res, 409, { error: 'nothing launched yet' })
      const ps = spawnSync(
        'docker',
        // Pipe-separated on purpose: with shell:true (Windows) the tab in a
        // \t-separated --format is eaten by the shell, and every Status card
        // came back empty on exactly the platform the GUI exists for.
        composeArgs(lastRun.flags, ['ps', '--format', '{{.Service}}|{{.State}}|{{.Status}}'], {
          mediaDriver: lastRun.mediaDriver,
          livekitBundled: lastRun.livekitBundled,
        }),
        { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' }
      )
      const containers = (ps.stdout || '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [service, state, status] = l.split('|')
          return { service, state, status }
        })
      let health = 'unknown'
      try {
        const r = await fetch(`${lastRun.origin}/health`, { signal: AbortSignal.timeout(3000) })
        health = r.ok ? 'healthy' : `http ${r.status}`
      } catch {
        health = 'unreachable'
      }
      return json(res, 200, {
        origin: lastRun.origin,
        health,
        containers,
        // One line: the backslash continuation this used to print is bash
        // syntax, and PowerShell / cmd cannot run what the operator copies.
        ownerCmd:
          'docker compose --env-file .env.lite -f docker-compose.lite.yml exec db ' +
          'psql -U forest -d forest -c "UPDATE users SET user_group=\'creator\', role=\'admin\' WHERE username=\'YOURNAME\';"',
      })
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  } catch (e) {
    json(res, 500, { error: e?.message || 'internal error' })
  }
})

// A second wizard (or anything else on 4173) otherwise dies with a bare
// ECONNREFUSED stack trace that says nothing about which port to change.
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    process.stderr.write(
      `\n  Port ${PORT} is already in use — another wizard may still be running.\n` +
        `  Close it, or pick another port:  node scripts/lite/wizard/server.mjs --port ${PORT + 1}\n\n`
    )
    process.exit(1)
  }
  process.stderr.write(`\n  wizard failed to start: ${e?.message || e}\n\n`)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}`
  process.stdout.write(`\n  OneToThree Lite — setup wizard running at ${link}\n  (Ctrl-C to stop)\n\n`)
  if (!NO_OPEN) {
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]]
      : process.platform === 'darwin' ? ['open', [link]]
      : ['xdg-open', [link]]
    try {
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
    } catch {
      /* user can open the link manually */
    }
  }
})

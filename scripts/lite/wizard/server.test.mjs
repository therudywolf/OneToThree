/**
 * End-to-end tests for the Lite setup wizard's HTTP layer.
 *
 * The wizard is what most operators actually install with, and until now not a
 * single line of it was tested: `npm run test:lite` only covered lite-core.
 * These run the REAL server process against a throwaway repo root
 * (`OT_LITE_REPO`), so nothing here can touch a working install's `.env.lite`.
 *
 * Nothing below ever reaches `docker`: `/api/launch` is only exercised in
 * states where it returns before spawning anything.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.mjs')

/** Ask the OS for a port nobody is using, then hand it to the wizard. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** Start a wizard against a fresh fixture root; resolves once it is listening. */
async function startWizard() {
  const repo = mkdtempSync(join(tmpdir(), 'lite-wizard-'))
  const port = await freePort()
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-open'], {
    env: { ...process.env, OT_LITE_REPO: repo },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wizard did not start:\n${out}`)), 15000)
    child.stdout.on('data', (d) => {
      out += d
      if (out.includes('setup wizard running')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`wizard exited with ${code}:\n${out}`))
    })
  })
  return {
    port,
    repo,
    base: `http://127.0.0.1:${port}`,
    stop() {
      child.kill()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** A request as the wizard's own page would send it. */
const sameOrigin = (w, path, init = {}) =>
  fetch(`${w.base}${path}`, {
    ...init,
    headers: {
      origin: w.base,
      'sec-fetch-site': 'same-origin',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })

const generateBody = (over = {}) =>
  JSON.stringify({
    mode: 'local',
    opts: { httpPort: '8443' },
    flags: { MEDIA: true, STICKERS: true, GIF: true, '2FA': true, PUSH: true },
    ...over,
  })

let W
before(async () => {
  W = await startWizard()
})
after(() => W?.stop())

describe('serving the wizard', () => {
  test('the UI is served on /', async () => {
    const r = await sameOrigin(W, '/')
    assert.equal(r.status, 200)
    assert.match(await r.text(), /<html|<!doctype/i)
  })

  test('an unknown path is a 404, not a file off disk', async () => {
    // A path-traversal attempt must not reach the repository.
    const r = await fetch(`${W.base}/../../package.json`, { headers: { origin: W.base } })
    assert.ok(r.status === 404 || r.status === 400, `got ${r.status}`)
  })

  test('preflight reports what the machine has', async () => {
    const r = await sameOrigin(W, '/api/preflight')
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok('docker' in body && 'compose' in body && 'node' in body)
  })
})

describe('cross-origin requests are refused', () => {
  /**
   * The whole point of the guard: while the wizard is open, any page the
   * operator visits could POST here. `text/plain` skips the preflight, and the
   * body used to be JSON.parse'd regardless — so a random site could rewrite
   * `.env.lite` (mode, origin, and every feature flag, guest links included).
   */
  test('a drive-by POST cannot rewrite .env.lite', async () => {
    const r = await fetch(`${W.base}/api/generate`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: generateBody({ flags: { GUESTS: true } }),
    })
    assert.equal(r.status, 403)
    assert.ok(!existsSync(join(W.repo, '.env.lite')), 'the refused request still wrote a config')
  })

  /**
   * `/api/launch` runs `docker compose up -d --build`. A cross-origin
   * EventSource cannot read the response, but the request still arrives — so
   * the refusal has to happen before anything is spawned. This wizard has not
   * generated a config yet, so even a failure here cannot start Docker.
   */
  test('a drive-by GET cannot start docker', async () => {
    const r = await fetch(`${W.base}/api/launch`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(r.status, 403)
  })

  // `fetch` refuses to set Host (a forbidden header), so this one goes out over
  // node:http — which is also how a rebinding attack would actually arrive.
  test('a request under a rebound DNS name is refused', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: W.port, path: '/api/defaults', headers: { Host: 'rebind.evil.example' } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        }
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  })
})

describe('generating the config', () => {
  test('writes .env.lite and the Caddyfile into the repo root', async () => {
    const r = await sameOrigin(W, '/api/generate', { method: 'POST', body: generateBody() })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.origin, 'http://localhost:8443')
    assert.ok(existsSync(join(W.repo, '.env.lite')))
    assert.ok(existsSync(join(W.repo, 'infra', 'lite', 'Caddyfile')))
  })

  /**
   * `.env.lite` carries the DB password, the JWT secret, the TOTP wrapping key
   * and the VAPID private key. At the default 0644 every other local account
   * can read them.
   */
  test('.env.lite is not readable by other users on the machine', { skip: process.platform === 'win32' }, () => {
    const mode = statSync(join(W.repo, '.env.lite')).mode & 0o777
    assert.equal(mode, 0o600, `.env.lite is ${mode.toString(8)}`)
  })

  /**
   * The bug: both installers minted a fresh VAPID pair on every run where push
   * was on, and that fresh pair beat the stored one. Re-running the wizard to
   * flip an unrelated checkbox silently unsubscribed every enrolled browser.
   */
  test('re-generating keeps the VAPID pair browsers are subscribed to', async () => {
    const first = readFileSync(join(W.repo, '.env.lite'), 'utf8')
    const pub = /^OT_VAPID_PUBLIC_KEY=(.*)$/m.exec(first)?.[1]
    const priv = /^OT_VAPID_PRIVATE_KEY=(.*)$/m.exec(first)?.[1]
    assert.ok(pub && priv, 'push was enabled, so keys must have been generated')

    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({ flags: { MEDIA: true, PUSH: true, GIF: false } }), // changed a feature
    })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).vapidKept, true)

    const second = readFileSync(join(W.repo, '.env.lite'), 'utf8')
    assert.equal(/^OT_VAPID_PUBLIC_KEY=(.*)$/m.exec(second)?.[1], pub)
    assert.equal(/^OT_VAPID_PRIVATE_KEY=(.*)$/m.exec(second)?.[1], priv)
    assert.match(second, /^OT_ENABLE_GIF=0$/m, 'the change the operator asked for must still apply')
  })

  test('an explicit rotate request does issue a new pair', async () => {
    const before = /^OT_VAPID_PUBLIC_KEY=(.*)$/m.exec(readFileSync(join(W.repo, '.env.lite'), 'utf8'))?.[1]
    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({ rotateVapid: true }),
    })
    assert.equal((await r.json()).vapidGenerated, true)
    const after = /^OT_VAPID_PUBLIC_KEY=(.*)$/m.exec(readFileSync(join(W.repo, '.env.lite'), 'utf8'))?.[1]
    assert.notEqual(after, before)
  })

  test('the database and session secrets survive every re-generate', async () => {
    const pick = (t, k) => new RegExp(`^${k}=(.*)$`, 'm').exec(t)?.[1]
    const first = readFileSync(join(W.repo, '.env.lite'), 'utf8')
    await sameOrigin(W, '/api/generate', { method: 'POST', body: generateBody({ mode: 'local' }) })
    const second = readFileSync(join(W.repo, '.env.lite'), 'utf8')
    for (const k of ['OT_DB_PASSWORD', 'OT_JWT_SECRET', 'OT_TOTP_WRAP_KEY', 'OT_MINIO_PASSWORD']) {
      assert.equal(pick(second, k), pick(first, k), `${k} must not be re-minted`)
    }
  })

  /** A typo used to reach `.env.lite` as `NaN` and fail inside docker instead. */
  test('a non-numeric port is rejected with a reason, not written out', async () => {
    const before = readFileSync(join(W.repo, '.env.lite'), 'utf8')
    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({ opts: { httpPort: 'eight thousand' } }),
    })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /number/i)
    assert.equal(readFileSync(join(W.repo, '.env.lite'), 'utf8'), before, '.env.lite was modified anyway')
  })

  /**
   * The GUI pre-fills the object store with http://localhost:9000 for local
   * mode and used to keep it when the operator switched to a public domain —
   * shipping an install where every remote browser fetches media from its own
   * machine. The install itself looks perfectly healthy.
   */
  test('a localhost object store on a public domain is refused', async () => {
    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({
        mode: 'domain',
        opts: { domain: 'chat.example.com' },
        flags: { MEDIA: true },
        s3PublicUrl: 'http://localhost:9000',
      }),
    })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /only works on this machine/)
  })

  test('the same URL is fine in local mode', async () => {
    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({ flags: { MEDIA: true }, s3PublicUrl: 'http://localhost:9000' }),
    })
    assert.equal(r.status, 200)
  })

  /** A pasted value with a newline would append its own env vars. */
  test('a domain carrying a line break is rejected', async () => {
    const r = await sameOrigin(W, '/api/generate', {
      method: 'POST',
      body: generateBody({ mode: 'domain', opts: { domain: 'chat.example.com\nOT_ENABLE_GUESTS=1' } }),
    })
    assert.equal(r.status, 400)
    assert.doesNotMatch(readFileSync(join(W.repo, '.env.lite'), 'utf8'), /^OT_ENABLE_GUESTS=1$/m)
  })
})

describe('launching', () => {
  test('a fresh wizard refuses to launch before a config exists', async () => {
    const w2 = await startWizard()
    try {
      const r = await sameOrigin(w2, '/api/launch')
      assert.equal(r.status, 409) // returns before spawning docker
      const s = await sameOrigin(w2, '/api/status')
      assert.equal(s.status, 409)
    } finally {
      w2.stop()
    }
  })
})

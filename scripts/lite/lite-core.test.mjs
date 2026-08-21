/**
 * Tests for the Lite installer core.
 *
 * `node --test` on purpose: lite-core.mjs is deliberately dependency-free so the
 * installer runs against a fresh clone BEFORE `npm install`, and a test that
 * needed vitest would quietly break that promise.
 *
 * What is worth pinning here is the stuff a human cannot see by reading the
 * wizard: the secure-context invariants each mode has to satisfy, and the fact
 * that configuring LiveKit actually reaches the API.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FEATURES,
  computeModeConfig,
  buildEnv,
  renderCaddyfile,
  renderEnvFile,
  writeArtifacts,
  readExistingEnv,
  composeArgs,
  renderLivekitConfig,
  resolveLivekit,
  resolveMediaDriver,
  generateVapidKeys,
  resolveVapid,
  s3UrlProblem,
  minioBind,
  assertHost,
  parsePort,
  normalizeSubject,
} from './lite-core.mjs'

const flagsFor = (over = {}) =>
  Object.fromEntries(FEATURES.map((f) => [f.key, over[f.key] ?? (f.on ? '1' : '0')]))

describe('deployment modes', () => {
  /**
   * The whole reason three modes exist: Web Crypto — and therefore all E2EE —
   * is only exposed in a secure context. Plain HTTP is acceptable ONLY on
   * localhost. If a mode reachable off-box ever stopped being HTTPS, the app
   * would still load and silently have no crypto.
   */
  test('every off-box mode is HTTPS with a secure cookie', () => {
    for (const [mode, opts] of [
      ['lan', { host: '192.168.1.50' }],
      ['domain', { domain: 'chat.example.com' }],
    ]) {
      const cfg = computeModeConfig(mode, opts)
      assert.match(cfg.origin, /^https:\/\//, `${mode} origin must be https`)
      assert.equal(cfg.cookieSecure, '1', `${mode} cookie must be Secure`)
      assert.equal(cfg.nodeEnv, 'production')
    }
  })

  test('local mode is plain HTTP but ONLY on localhost', () => {
    const cfg = computeModeConfig('local', { httpPort: '8443' })
    assert.equal(cfg.origin, 'http://localhost:8443')
    assert.equal(cfg.host, 'localhost')
    assert.equal(cfg.cookieSecure, '0')
  })

  test('an unknown mode falls back to local rather than something insecure', () => {
    assert.equal(computeModeConfig('nonsense').mode, 'local')
  })

  test('lan maps the host HTTPS port 1:1 so the cert matches host:port', () => {
    const cfg = computeModeConfig('lan', { host: '10.0.0.5', httpsPort: '9443' })
    assert.equal(cfg.httpsContainerPort, '9443')
    assert.equal(cfg.origin, 'https://10.0.0.5:9443')
  })
})

describe('Caddyfile', () => {
  test('local disables auto-HTTPS and listens on :80', () => {
    const out = renderCaddyfile(computeModeConfig('local', { httpPort: '8443' }))
    assert.match(out, /auto_https off/)
    assert.match(out, /^:80 \{/m)
  })

  test('lan serves the internal CA on the exact host:port', () => {
    const out = renderCaddyfile(computeModeConfig('lan', { host: '10.0.0.5', httpsPort: '9443' }))
    assert.match(out, /https:\/\/10\.0\.0\.5:9443 \{/)
    assert.match(out, /tls internal/)
  })

  test('domain carries the ACME email', () => {
    const out = renderCaddyfile(
      computeModeConfig('domain', { domain: 'chat.example.com', acmeEmail: 'me@example.com' })
    )
    assert.match(out, /email me@example\.com/)
    assert.match(out, /^chat\.example\.com \{/m)
  })

  test('every mode routes /api and the WebSocket to the API, the rest to web', () => {
    for (const mode of ['local', 'lan', 'domain']) {
      const out = renderCaddyfile(computeModeConfig(mode, {}))
      assert.match(out, /handle \/api\/\* \{\n\t\treverse_proxy api:8080/)
      assert.match(out, /handle \{\n\t\treverse_proxy web:3000/)
      assert.match(out, /handle \/health \{/)
    }
  })
})

describe('re-running the installer', () => {
  /**
   * The guide tells operators to re-run the installer to change mode or
   * features. That used to mint a fresh set of secrets — and Postgres and MinIO
   * only apply their root credentials on FIRST init, so the volumes kept the
   * old ones and the whole stack came back up with `password authentication
   * failed`. Rotating the other two is quieter and worse: a new TOTP_WRAP_KEY
   * makes every enrolled 2FA secret undecryptable, a new JWT_SECRET logs
   * everyone out.
   */
  test('keeps the credentials the existing volumes were created with', () => {
    const first = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    const second = buildEnv({
      cfg: computeModeConfig('lan', { host: '10.0.0.5' }), // changed mode
      flags: flagsFor({ GIF: '0' }),                        // changed features
      existing: first,
    })
    for (const k of ['OT_DB_PASSWORD', 'OT_JWT_SECRET', 'OT_TOTP_WRAP_KEY', 'OT_MINIO_PASSWORD']) {
      assert.equal(second[k], first[k], `${k} must survive a reconfigure`)
    }
    // …while the things the operator actually changed do change.
    assert.equal(second.OT_ENABLE_GIF, '0')
    assert.match(second.OT_ORIGIN, /^https:\/\/10\.0\.0\.5/)
  })

  test('a first install with no .env.lite still generates everything', () => {
    const env = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor(), existing: {} })
    assert.ok(env.OT_DB_PASSWORD.length >= 32)
    assert.ok(env.OT_JWT_SECRET.length >= 32)
  })

  /**
   * The test below this one pins `buildEnv` called WITHOUT a `vapid` argument —
   * a path neither installer ever took. Both minted a fresh pair on every run
   * where push was on, and a supplied pair always wins, so re-running the
   * installer to flip any unrelated checkbox silently unsubscribed every
   * enrolled browser while this suite stayed green. `resolveVapid` is what the
   * callers use now, so this is the invariant that actually ships.
   */
  test('the installers keep the enrolled VAPID pair across a re-run', () => {
    const first = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ PUSH: '1' }),
      vapid: resolveVapid({ existing: {}, subject: 'mailto:me@example.com' }),
    })
    const again = resolveVapid({ existing: first, subject: 'mailto:me@example.com' })
    assert.equal(again.rotated, false)
    const second = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ PUSH: '1', GIF: '0' }),
      vapid: again,
      existing: first,
    })
    assert.equal(second.OT_VAPID_PUBLIC_KEY, first.OT_VAPID_PUBLIC_KEY)
    assert.equal(second.OT_VAPID_PRIVATE_KEY, first.OT_VAPID_PRIVATE_KEY)
    assert.equal(second.OT_ENABLE_GIF, '0')
  })

  test('a first install with no stored pair mints one', () => {
    const v = resolveVapid({ existing: {}, subject: 'admin@example.com' })
    assert.equal(v.rotated, true)
    assert.equal(v.subject, 'mailto:admin@example.com')
    assert.equal(v.publicKey.length, 87)
  })

  test('an operator can still ask for a rotation on purpose', () => {
    const first = resolveVapid({ existing: {} })
    const rotated = resolveVapid({
      existing: { OT_VAPID_PUBLIC_KEY: first.publicKey, OT_VAPID_PRIVATE_KEY: first.privateKey },
      rotate: true,
    })
    assert.equal(rotated.rotated, true)
    assert.notEqual(rotated.publicKey, first.publicKey)
  })

  test('a half-written pair is treated as no pair rather than half-kept', () => {
    const v = resolveVapid({ existing: { OT_VAPID_PUBLIC_KEY: 'only-the-public-half' } })
    assert.equal(v.rotated, true)
    assert.notEqual(v.publicKey, 'only-the-public-half')
  })

  test('changing only the contact address does not rotate the keys', () => {
    const first = resolveVapid({ existing: {}, subject: 'mailto:old@example.com' })
    const stored = {
      OT_VAPID_PUBLIC_KEY: first.publicKey,
      OT_VAPID_PRIVATE_KEY: first.privateKey,
      OT_VAPID_SUBJECT: first.subject,
    }
    const next = resolveVapid({ existing: stored, subject: 'new@example.com' })
    assert.equal(next.publicKey, first.publicKey)
    assert.equal(next.subject, 'mailto:new@example.com')
  })

  test('push keys survive a reconfigure that does not re-issue them', () => {
    const first = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ PUSH: '1' }),
    })
    const second = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ PUSH: '1' }),
      existing: first,
    })
    // A rotated VAPID pair silently unsubscribes every browser already enrolled.
    assert.equal(second.OT_VAPID_PUBLIC_KEY, first.OT_VAPID_PUBLIC_KEY)
    assert.equal(second.OT_VAPID_PRIVATE_KEY, first.OT_VAPID_PRIVATE_KEY)
  })

  test('explicitly supplied VAPID keys still win over the stored pair', () => {
    const first = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor({ PUSH: '1' }) })
    const fresh = generateVapidKeys('mailto:new@example.com')
    const second = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ PUSH: '1' }),
      vapid: fresh,
      existing: first,
    })
    assert.equal(second.OT_VAPID_PUBLIC_KEY, fresh.publicKey)
    assert.equal(second.OT_VAPID_SUBJECT, 'mailto:new@example.com')
  })
})

/**
 * Everything an operator types goes into two line-oriented, unquoted files
 * (`.env.lite`, `infra/lite/Caddyfile`) and into `docker compose` arguments.
 * None of it used to be validated: a typo produced a broken install with an
 * error pointing somewhere else, and a line break produced extra config.
 */
describe('operator input is validated before it reaches a config file', () => {
  test('a port that is not a number is refused, instead of becoming NaN', () => {
    assert.throws(() => computeModeConfig('local', { httpPort: 'eight' }), /number/i)
    assert.throws(() => computeModeConfig('lan', { host: '10.0.0.5', httpsPort: '99999' }), /65535/)
    assert.equal(parsePort('port', '', '8443'), '8443')
    assert.equal(parsePort('port', ' 8080 ', '8443'), '8080')
  })

  test('a host with a line break cannot append Caddy directives', () => {
    assert.throws(() => computeModeConfig('lan', { host: '10.0.0.5\nrespond "pwned"' }), /line break/)
    assert.throws(() => computeModeConfig('domain', { domain: 'a.example.com\n:8080 {' }), /line break/)
  })

  test('a host that is not a hostname or an IP is refused', () => {
    assert.throws(() => assertHost('domain', 'chat.example.com {'), /valid hostname/)
    assert.throws(() => assertHost('domain', 'http://chat.example.com'), /valid hostname/)
    assert.throws(() => assertHost('domain', ''), /empty/)
    assert.equal(assertHost('domain', ' chat.example.com '), 'chat.example.com')
    assert.equal(assertHost('lan', '192.168.1.50'), '192.168.1.50')
  })

  /** `example.com` used to derive `admin@com`, which Let's Encrypt rejects. */
  test('the auto ACME email is derived sanely for an apex domain', () => {
    assert.equal(computeModeConfig('domain', { domain: 'example.com' }).acmeEmail, 'admin@example.com')
    assert.equal(computeModeConfig('domain', { domain: 'chat.example.com' }).acmeEmail, 'admin@example.com')
    assert.equal(
      computeModeConfig('domain', { domain: 'chat.example.com', acmeEmail: 'me@example.com' }).acmeEmail,
      'me@example.com'
    )
  })

  test('a value with a newline never reaches .env.lite as extra variables', () => {
    assert.throws(
      () => renderEnvFile({ OT_LIVEKIT_API_SECRET: 'secret\nOT_ENABLE_GUESTS=1' }),
      /line break/
    )
  })

  /**
   * Media is fetched by the browser, so a localhost object store outside local
   * mode is broken for everyone except the machine running the server — and it
   * is what an operator ends up with, because the GUI pre-fills it and the
   * field survives a mode change.
   */
  test('a localhost object store is refused outside local mode', () => {
    const media = flagsFor({ MEDIA: '1' })
    const domain = computeModeConfig('domain', { domain: 'chat.example.com' })
    assert.match(
      s3UrlProblem({ cfg: domain, flags: media, s3PublicUrl: 'http://localhost:9000' }) || '',
      /only works on this machine/
    )
    assert.ok(s3UrlProblem({ cfg: domain, flags: media, s3PublicUrl: 'http://127.0.0.1:9000' }))
    assert.equal(s3UrlProblem({ cfg: domain, flags: media, s3PublicUrl: 'https://s3.example.com' }), null)
  })

  test('local mode may of course use localhost, and blank stays allowed', () => {
    const local = computeModeConfig('local', {})
    const media = flagsFor({ MEDIA: '1' })
    assert.equal(s3UrlProblem({ cfg: local, flags: media, s3PublicUrl: 'http://localhost:9000' }), null)
    const domain = computeModeConfig('domain', { domain: 'chat.example.com' })
    assert.equal(s3UrlProblem({ cfg: domain, flags: media, s3PublicUrl: '' }), null)
  })

  test('with no media and no stickers the object store is nobody’s business', () => {
    const domain = computeModeConfig('domain', { domain: 'chat.example.com' })
    const none = flagsFor({ MEDIA: '0', STICKERS: '0' })
    assert.equal(s3UrlProblem({ cfg: domain, flags: none, s3PublicUrl: 'http://localhost:9000' }), null)
  })

  test('stickers alone still need a reachable object store', () => {
    const domain = computeModeConfig('domain', { domain: 'chat.example.com' })
    const stickers = flagsFor({ MEDIA: '0', STICKERS: '1' })
    assert.ok(s3UrlProblem({ cfg: domain, flags: stickers, s3PublicUrl: 'http://localhost:9000' }))
  })

  test('a push contact is normalized into a scheme VAPID accepts', () => {
    assert.equal(normalizeSubject('admin@example.com'), 'mailto:admin@example.com')
    assert.equal(normalizeSubject('mailto:a@b.c'), 'mailto:a@b.c')
    assert.equal(normalizeSubject('https://example.com/contact'), 'https://example.com/contact')
    assert.equal(normalizeSubject(''), 'mailto:admin@localhost')
  })
})

/**
 * Everything above works on objects in memory. The guarantee operators actually
 * depend on — "re-running the installer keeps your database working" — runs
 * through a FILE: `writeArtifacts` renders it, `readExistingEnv` parses it back.
 * Neither was imported by this suite, so the whole round-trip could be deleted
 * and `npm run test:lite` would stay green.
 */
describe('the .env.lite round-trip', () => {
  const withRepo = (fn) => {
    const repo = mkdtempSync(join(tmpdir(), 'lite-core-'))
    try {
      return fn(repo)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }

  test('what the installer writes is what it reads back', () =>
    withRepo((repo) => {
      const cfg = computeModeConfig('local', {})
      const first = buildEnv({ cfg, flags: flagsFor({ PUSH: '1' }) })
      writeArtifacts(repo, first, renderCaddyfile(cfg))

      const parsed = readExistingEnv(repo)
      for (const [k, v] of Object.entries(first)) {
        assert.equal(parsed[k], v, `${k} did not survive the round-trip`)
      }
    }))

  test('a re-run through real files keeps the volumes authenticating', () =>
    withRepo((repo) => {
      const cfg = computeModeConfig('local', {})
      const first = buildEnv({ cfg, flags: flagsFor() })
      writeArtifacts(repo, first, renderCaddyfile(cfg))

      // Second run: different mode and features, same repo — exactly what the
      // guide tells operators to do.
      const lan = computeModeConfig('lan', { host: '10.0.0.5' })
      const second = buildEnv({ cfg: lan, flags: flagsFor({ GIF: '0' }), existing: readExistingEnv(repo) })
      writeArtifacts(repo, second, renderCaddyfile(lan))

      const onDisk = readExistingEnv(repo)
      for (const k of ['OT_DB_PASSWORD', 'OT_JWT_SECRET', 'OT_TOTP_WRAP_KEY', 'OT_MINIO_PASSWORD']) {
        assert.equal(onDisk[k], first[k], `${k} changed — the existing volumes would stop authenticating`)
      }
      assert.equal(onDisk.OT_ENABLE_GIF, '0')
      assert.match(onDisk.OT_ORIGIN, /^https:\/\/10\.0\.0\.5/)
    }))

  test('a value containing `=` survives (base64 secrets end in padding)', () =>
    withRepo((repo) => {
      const cfg = computeModeConfig('local', {})
      const env = { ...buildEnv({ cfg, flags: flagsFor() }), OT_LIVEKIT_API_SECRET: 'YWJj=ZGVm==' }
      writeArtifacts(repo, env, renderCaddyfile(cfg))
      assert.equal(readExistingEnv(repo).OT_LIVEKIT_API_SECRET, 'YWJj=ZGVm==')
    }))

  test('a hand-edited file with comments, blanks and CRLF still parses', () =>
    withRepo((repo) => {
      writeFileSync(
        join(repo, '.env.lite'),
        '# generated\r\n\r\nOT_JWT_SECRET=abc123\r\n# OT_ENABLE_GIF=1\r\nOT_ENABLE_GIF=0\r\n'
      )
      const parsed = readExistingEnv(repo)
      assert.equal(parsed.OT_JWT_SECRET, 'abc123')
      assert.equal(parsed.OT_ENABLE_GIF, '0')
      assert.ok(!('# OT_ENABLE_GIF' in parsed))
    }))

  test('no .env.lite means a first install, not a crash', () =>
    withRepo((repo) => {
      assert.deepEqual(readExistingEnv(repo), {})
    }))

  test('the Caddyfile lands where compose mounts it from', () =>
    withRepo((repo) => {
      const cfg = computeModeConfig('domain', { domain: 'chat.example.com' })
      writeArtifacts(repo, buildEnv({ cfg, flags: flagsFor() }), renderCaddyfile(cfg))
      const caddy = readFileSync(join(repo, 'infra', 'lite', 'Caddyfile'), 'utf8')
      assert.match(caddy, /^chat\.example\.com \{/m)
    }))

  test('.env.lite is written unreadable to other local users', { skip: process.platform === 'win32' }, () =>
    withRepo((repo) => {
      const cfg = computeModeConfig('local', {})
      // Pre-create it world-readable: writeFileSync does not re-apply mode to an
      // existing file, which is the case a re-run actually hits.
      writeFileSync(join(repo, '.env.lite'), 'OT_JWT_SECRET=old\n', { mode: 0o644 })
      writeArtifacts(repo, buildEnv({ cfg, flags: flagsFor() }), renderCaddyfile(cfg))
      assert.equal(statSync(join(repo, '.env.lite')).mode & 0o777, 0o600)
    }))
})

/**
 * The bundled MinIO speaks plain HTTP and holds the root credentials from
 * .env.lite. It rode OT_BIND, which is empty in lan and domain mode — so a
 * self-host on a public domain published an unencrypted object store on
 * 0.0.0.0, while the installer only warned that browsers could not reach it
 * over HTTPS.
 */
describe('where the object store is published', () => {
  const local = computeModeConfig('local', {})
  const domain = computeModeConfig('domain', { domain: 'chat.example.com' })
  const lan = computeModeConfig('lan', { host: '192.168.1.50' })

  test('local mode keeps it on loopback — the browser is on this machine', () => {
    assert.equal(minioBind({ cfg: local, s3PublicUrl: 'http://localhost:9000' }), '127.0.0.1:')
  })

  test('a fronted object store needs no public port at all', () => {
    assert.equal(minioBind({ cfg: domain, s3PublicUrl: 'https://s3.example.com' }), '127.0.0.1:')
  })

  test('media off, or no URL given, also stays on loopback', () => {
    assert.equal(minioBind({ cfg: domain, s3PublicUrl: '' }), '127.0.0.1:')
    assert.equal(minioBind({ cfg: lan, s3PublicUrl: 'not a url' }), '127.0.0.1:')
  })

  /** The one case that genuinely needs it: browsers pointed straight here. */
  test('a LAN install pointing browsers at this host opens the port', () => {
    assert.equal(minioBind({ cfg: lan, s3PublicUrl: 'http://192.168.1.50:9000' }), '')
  })

  test('a different host or port on the same machine does not open it', () => {
    assert.equal(minioBind({ cfg: lan, s3PublicUrl: 'http://192.168.1.51:9000' }), '127.0.0.1:')
    assert.equal(minioBind({ cfg: lan, s3PublicUrl: 'https://192.168.1.50' }), '127.0.0.1:')
  })

  test('the value reaches .env.lite', () => {
    const env = buildEnv({ cfg: domain, flags: flagsFor(), s3PublicUrl: 'https://s3.example.com' })
    assert.equal(env.OT_MINIO_BIND, '127.0.0.1:')
  })
})

describe('published ports', () => {
  /**
   * Published with no host, Docker Desktop also listens on `[::]`, and on
   * Windows that IPv6 listener accepts the connection and then answers nothing.
   * `localhost` resolves to ::1 first, so the exact URL the installer prints
   * gave the browser ERR_EMPTY_RESPONSE — and an accepted-then-silent socket
   * defeats the usual fallback to IPv4.
   */
  test('local pins every port to 127.0.0.1', () => {
    const env = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    assert.equal(env.OT_BIND, '127.0.0.1:')
  })

  test('lan and domain stay on 0.0.0.0 or they would be unreachable', () => {
    for (const [mode, opts] of [['lan', { host: '10.0.0.5' }], ['domain', { domain: 'x.example.com' }]]) {
      const env = buildEnv({ cfg: computeModeConfig(mode, opts), flags: flagsFor() })
      assert.equal(env.OT_BIND, '', `${mode} must not bind to loopback`)
    }
  })
})

describe('calls', () => {
  /**
   * The bug this pins: the API defaults to `origin_safe`, and in that mode
   * /call/config reports `livekit_enabled: false` whatever LIVEKIT_URL holds —
   * while the client checks `origin_safe` FIRST and takes the WebSocket audio
   * relay without ever requesting an SFU token. An operator who filled in a
   * LiveKit URL, key and secret had them silently ignored.
   */
  test('configuring LiveKit switches the API out of origin_safe', () => {
    const env = buildEnv({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { url: 'wss://livekit.example.com', key: 'k', secret: 's' },
    })
    assert.equal(env.OT_CALL_MEDIA_MODE, 'self_hosted')
    assert.equal(env.OT_LIVEKIT_URL, 'wss://livekit.example.com')
  })

  test('no LiveKit means the WebSocket relay, which is what Lite ships with', () => {
    const env = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ CALLS: '1' }),
      livekit: {},
    })
    assert.equal(env.OT_CALL_MEDIA_MODE, 'origin_safe')
    assert.equal(env.OT_LIVEKIT_URL, '')
  })

  /**
   * Bundling has to be asked for. An empty `livekit` is what every caller
   * written before the bundled SFU existed passes, and reading it as "yes,
   * start an SFU" would launch a container and open a UDP port on an install
   * that never mentioned either.
   */
  test('the bundled SFU is opt-in, never inferred', () => {
    const cfg = computeModeConfig('local', {})
    const flags = flagsFor({ CALLS: '1' })
    assert.equal(resolveLivekit({ cfg, flags, livekit: {} }).bundled, false)
    assert.equal(resolveLivekit({ cfg, flags, livekit: { bundled: true } }).bundled, true)
    // Calls off wins over everything.
    assert.equal(
      resolveLivekit({ cfg, flags: flagsFor({ CALLS: '0' }), livekit: { bundled: true } }).bundled,
      false
    )
  })

  test('the bundled SFU shares the app origin and matches its scheme', () => {
    const local = resolveLivekit({
      cfg: computeModeConfig('local', { httpPort: '8099' }),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { bundled: true },
    })
    // ws:// on plain HTTP; wss:// would be a mixed-content block with nothing
    // in any server log to explain it.
    assert.equal(local.url, 'ws://localhost:8099/livekit')

    const domain = resolveLivekit({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { bundled: true },
    })
    assert.equal(domain.url, 'wss://chat.example.com/livekit')
  })

  /**
   * The key ends up in TWO files: .env.lite (the API signs tokens with it) and
   * livekit.yaml (the SFU verifies them with it). Resolving twice would put a
   * different secret in each, and every token the API issued would be rejected.
   */
  test('resolving an already-resolved LiveKit keeps its keys', () => {
    const cfg = computeModeConfig('local', {})
    const flags = flagsFor({ CALLS: '1' })
    const first = resolveLivekit({ cfg, flags, livekit: { bundled: true } })
    const again = resolveLivekit({ cfg, flags, livekit: first })
    assert.equal(again.key, first.key)
    assert.equal(again.secret, first.secret)

    const env = buildEnv({ cfg, flags, livekit: first })
    assert.equal(env.OT_LIVEKIT_API_SECRET, first.secret)
    assert.equal(env.OT_LIVEKIT_URL, first.url)
    assert.equal(env.OT_CALL_MEDIA_MODE, 'self_hosted')
    // The admin API is reached over the container network, not through Caddy.
    assert.equal(env.OT_LIVEKIT_ADMIN_URL, 'http://livekit:7880')
  })

  test('re-running keeps the keys the running SFU has open', () => {
    const cfg = computeModeConfig('local', {})
    const flags = flagsFor({ CALLS: '1' })
    const existing = { OT_LIVEKIT_API_KEY: 'APIkeep', OT_LIVEKIT_API_SECRET: 'secretkeep' }
    const lk = resolveLivekit({ cfg, flags, livekit: { bundled: true }, existing })
    assert.equal(lk.key, 'APIkeep')
    assert.equal(lk.secret, 'secretkeep')
  })

  test('an external LiveKit still wins, and starts no container', () => {
    const lk = resolveLivekit({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { url: 'wss://lk.example.com', key: 'k', secret: 's', bundled: true },
    })
    assert.equal(lk.bundled, false)
    assert.equal(lk.url, 'wss://lk.example.com')
  })

  test('the media port is loopback locally and open elsewhere', () => {
    const local = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { bundled: true },
    })
    assert.equal(local.OT_LIVEKIT_BIND, '127.0.0.1:')
    const domain = buildEnv({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor({ CALLS: '1' }),
      livekit: { bundled: true },
    })
    assert.equal(domain.OT_LIVEKIT_BIND, '')
    assert.equal(domain.OT_LIVEKIT_UDP_PORT, '7882')
  })

  test('the SFU is told an address the browser can actually send media to', () => {
    const local = renderLivekitConfig({
      cfg: computeModeConfig('local', {}),
      apiKey: 'APIx',
      apiSecret: 'secret',
    })
    // A container on a bridge network advertises 172.x, which no browser can
    // reach. Pinning node_ip is the whole reason local calls connect at all.
    assert.match(local, /node_ip: 127\.0\.0\.1/)
    assert.match(local, /use_external_ip: false/)

    const lan = renderLivekitConfig({
      cfg: computeModeConfig('lan', { host: '192.168.1.50', httpsPort: '8443' }),
      apiKey: 'APIx',
      apiSecret: 'secret',
    })
    assert.match(lan, /node_ip: 192\.168\.1\.50/)

    const domain = renderLivekitConfig({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      apiKey: 'APIx',
      apiSecret: 'secret',
    })
    assert.match(domain, /use_external_ip: true/)
    assert.doesNotMatch(domain, /node_ip:/)
  })

  test('the SFU config carries the keys and the webhook, and no TURN', () => {
    const cfgText = renderLivekitConfig({
      cfg: computeModeConfig('local', {}),
      apiKey: 'APIabc',
      apiSecret: 'shhh',
    })
    assert.match(cfgText, /^ {2}APIabc: shhh$/m)
    // room_finished is how the per-call E2EE key gets dropped when a call ends.
    assert.match(cfgText, /http:\/\/api:8080\/api\/call\/livekit\/webhook/)
    assert.match(cfgText, /turn:\n {2}enabled: false/)
  })

  test('the bundled SFU adds a proxy route, and nothing else does', () => {
    const cfg = computeModeConfig('local', {})
    assert.doesNotMatch(renderCaddyfile(cfg), /livekit/)
    const withLk = renderCaddyfile(cfg, { livekitBundled: true })
    assert.match(withLk, /handle \/livekit\/\*/)
    assert.match(withLk, /uri strip_prefix \/livekit/)
    assert.match(withLk, /reverse_proxy livekit:7880/)
  })

  test('only a bundled SFU pulls in the calls profile', () => {
    const flags = flagsFor({ CALLS: '1' })
    assert.ok(
      composeArgs(flags, [], { mediaDriver: 'fs', livekitBundled: true }).includes('calls')
    )
    assert.ok(!composeArgs(flags, [], { mediaDriver: 'fs' }).includes('calls'))
  })
})

describe('features', () => {
  test('push generates a real VAPID pair only when push is on', () => {
    const off = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor({ PUSH: '0' }) })
    assert.equal(off.OT_VAPID_PUBLIC_KEY, undefined)

    const on = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor({ PUSH: '1' }) })
    // Uncompressed P-256 point (0x04‖X‖Y) → 65 bytes → 87 base64url chars;
    // the private scalar is 32 bytes → 43. A wrong length is a dead push setup.
    assert.equal(on.OT_VAPID_PUBLIC_KEY.length, 87)
    assert.equal(on.OT_VAPID_PRIVATE_KEY.length, 43)
    assert.match(on.OT_VAPID_SUBJECT, /^(mailto:|https:)/)
  })

  test('the generated VAPID public key is a valid uncompressed point', () => {
    const v = generateVapidKeys()
    const raw = Buffer.from(v.publicKey, 'base64url')
    assert.equal(raw.length, 65)
    assert.equal(raw[0], 0x04)
  })

  test('every secret is freshly generated per install', () => {
    const mk = () => buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    const a = mk()
    const b = mk()
    for (const k of ['OT_DB_PASSWORD', 'OT_JWT_SECRET', 'OT_TOTP_WRAP_KEY', 'OT_MINIO_PASSWORD']) {
      assert.notEqual(a[k], b[k], `${k} must not be reused between installs`)
      assert.ok(a[k].length >= 32, `${k} looks too short`)
    }
  })

  test('media or stickers pull in the MinIO profile; neither leaves it out', () => {
    const s3 = { mediaDriver: 's3' }
    assert.ok(composeArgs(flagsFor({ MEDIA: '1', STICKERS: '0' }), [], s3).includes('media'))
    assert.ok(composeArgs(flagsFor({ MEDIA: '0', STICKERS: '1' }), [], s3).includes('media'))
    assert.ok(!composeArgs(flagsFor({ MEDIA: '0', STICKERS: '0' }), [], s3).includes('media'))
  })

  /**
   * The whole point of the local driver is that the second container is GONE —
   * not stopped, not present-but-idle. Leaving the profile on would start MinIO
   * next to an API that never talks to it, and the operator would find a
   * container they cannot explain.
   */
  test('the local media driver starts no object store at all', () => {
    const args = composeArgs(flagsFor({ MEDIA: '1', STICKERS: '1' }), ['up', '-d'], {
      mediaDriver: 'fs',
    })
    assert.ok(!args.includes('media'), args.join(' '))
    assert.ok(!args.includes('--profile'), args.join(' '))
  })

  /**
   * A `.env.lite` written before the local driver existed says nothing about a
   * driver — and its photos are in MinIO. Reading that silence as "fs" would
   * bring the stack up pointed at an empty directory: every picture gone from
   * the app, none gone from the disk, nothing in any log.
   */
  test('an install from before the driver existed keeps its object store', () => {
    assert.equal(resolveMediaDriver({ existing: {} }), 'fs')
    assert.equal(resolveMediaDriver({ existing: { OT_JWT_SECRET: 'x' } }), 's3')
    assert.equal(
      resolveMediaDriver({ existing: { OT_JWT_SECRET: 'x', OT_MEDIA_DRIVER: 'fs' } }),
      'fs'
    )
    // An explicit choice always wins — that is the operator switching on purpose.
    assert.equal(
      resolveMediaDriver({ mediaDriver: 'fs', existing: { OT_JWT_SECRET: 'x' } }),
      'fs'
    )
    assert.equal(resolveMediaDriver({ mediaDriver: 's3', existing: {} }), 's3')
    // Junk in the file is not a third driver.
    assert.equal(resolveMediaDriver({ existing: { OT_MEDIA_DRIVER: 'nonsense' } }), 's3')
  })

  test('the local driver writes an ABSOLUTE media base and no object-store URL', () => {
    const env = buildEnv({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor(),
      s3PublicUrl: 'https://s3.example.com',
      mediaDriver: 'fs',
    })
    assert.equal(env.OT_MEDIA_DRIVER, 'fs')
    // Absolute, because the APK and the desktop shell load the page from their
    // own WebView origin and would resolve a relative one against that.
    assert.equal(env.OT_MEDIA_PUBLIC_URL, 'https://chat.example.com/api')
    // The S3 URL the operator typed must not survive into an fs install: it is
    // config they would believe is applied, pointing at a container that is not
    // running.
    assert.equal(env.OT_S3_PUBLIC_URL, '')
    assert.equal(env.OT_MINIO_BIND, '127.0.0.1:')
  })

  test('the s3 driver still writes what MinIO needs', () => {
    const env = buildEnv({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor(),
      s3PublicUrl: 'https://s3.example.com',
      mediaDriver: 's3',
    })
    assert.equal(env.OT_MEDIA_DRIVER, 's3')
    assert.equal(env.OT_MEDIA_PUBLIC_URL, '')
    assert.equal(env.OT_S3_PUBLIC_URL, 'https://s3.example.com')
  })

  test('a new install defaults to the local driver', () => {
    const env = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    assert.equal(env.OT_MEDIA_DRIVER, 'fs')
    assert.equal(env.OT_MEDIA_PUBLIC_URL, `${computeModeConfig('local', {}).origin}/api`)
  })

  test('the object-store URL warning does not fire when there is no object store', () => {
    const cfg = computeModeConfig('domain', { domain: 'chat.example.com' })
    const flags = flagsFor()
    assert.ok(s3UrlProblem({ cfg, flags, s3PublicUrl: 'http://localhost:9000' }))
    assert.equal(
      s3UrlProblem({ cfg, flags, s3PublicUrl: 'http://localhost:9000', mediaDriver: 'fs' }),
      null
    )
  })

  test('compose always targets the Lite file and its env', () => {
    const args = composeArgs(flagsFor(), ['up', '-d'])
    assert.deepEqual(args.slice(0, 5), [
      'compose', '--env-file', '.env.lite', '-f', 'docker-compose.lite.yml',
    ])
    assert.deepEqual(args.slice(-2), ['up', '-d'])
  })

  /**
   * The server has always honoured FEATURE_OPEN_REGISTRATION, but Lite never
   * emitted it — so a self-hoster on a public domain could not close sign-ups
   * by any means at all. It stays ON by default (that is the behaviour every
   * existing install already has) and is now a checkbox that actually works.
   */
  test('open registration can be switched off, and defaults to on', () => {
    assert.equal(FEATURES.find((f) => f.key === 'OPEN_REGISTRATION')?.on, true)
    const on = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    assert.equal(on.OT_ENABLE_OPEN_REGISTRATION, '1')
    const off = buildEnv({
      cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
      flags: flagsFor({ OPEN_REGISTRATION: '0' }),
    })
    assert.equal(off.OT_ENABLE_OPEN_REGISTRATION, '0')
  })

  /**
   * Guest links are the ONLY unauthenticated entry into the app, so an
   * operator has to ask for them: the checkbox ships off, and the env var must
   * carry that through — a default-on guest mode would silently open a door on
   * every Lite install.
   */
  test('guest links are opt-in and reach the API as OT_ENABLE_GUESTS', () => {
    assert.equal(FEATURES.find((f) => f.key === 'GUESTS')?.on, false)
    const off = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })
    assert.equal(off.OT_ENABLE_GUESTS, '0')
    const on = buildEnv({
      cfg: computeModeConfig('local', {}),
      flags: flagsFor({ GUESTS: '1' }),
    })
    assert.equal(on.OT_ENABLE_GUESTS, '1')
  })
})


/**
 * The first-admin handle. This is the knob that decides whether a fresh Lite
 * install has a usable admin panel at all, and it lands in a line-oriented
 * `.env.lite` — so it has to survive being blank and must refuse a newline.
 */
describe('first-admin handle', () => {
  const base = { cfg: computeModeConfig('local', {}), flags: Object.fromEntries(FEATURES.map((f) => [f.key, f.on ? '1' : '0'])) }

  test('blank by default — the knob is opt-in, not a surprise promotion', () => {
    assert.equal(buildEnv(base).OT_ADMIN_USERNAME, '')
  })

  test('a handle is written verbatim, trimmed', () => {
    assert.equal(buildEnv({ ...base, adminUsername: '  rudywolf  ' }).OT_ADMIN_USERNAME, 'rudywolf')
  })

  test('a newline is refused rather than appended as another variable', () => {
    assert.throws(
      () => buildEnv({ ...base, adminUsername: 'me\nOT_ENABLE_GUESTS=1' }),
      /line break/
    )
  })
})

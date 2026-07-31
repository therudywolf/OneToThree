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
import {
  FEATURES,
  computeModeConfig,
  buildEnv,
  renderCaddyfile,
  composeArgs,
  generateVapidKeys,
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
    assert.ok(composeArgs(flagsFor({ MEDIA: '1', STICKERS: '0' })).includes('media'))
    assert.ok(composeArgs(flagsFor({ MEDIA: '0', STICKERS: '1' })).includes('media'))
    assert.ok(!composeArgs(flagsFor({ MEDIA: '0', STICKERS: '0' })).includes('media'))
  })

  test('compose always targets the Lite file and its env', () => {
    const args = composeArgs(flagsFor(), ['up', '-d'])
    assert.deepEqual(args.slice(0, 5), [
      'compose', '--env-file', '.env.lite', '-f', 'docker-compose.lite.yml',
    ])
    assert.deepEqual(args.slice(-2), ['up', '-d'])
  })
})

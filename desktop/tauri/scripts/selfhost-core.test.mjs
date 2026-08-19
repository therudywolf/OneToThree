/**
 * Tests for the self-host desktop build core.
 *
 * `node --test` on purpose, like scripts/lite/lite-core.test.mjs: this code has
 * to run from a fresh clone with no workspace-level test runner, and the whole
 * point of splitting it out of build-selfhost.mjs was to be able to check it
 * WITHOUT a Rust toolchain or a 20-minute bundle.
 *
 * What is worth pinning: an installer that builds successfully and is dead on
 * arrival is the failure mode here — nothing crashes, the bundle appears, and
 * the app simply cannot reach any server. Every test below guards one way that
 * has already happened or can happen silently.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseEnvFile,
  resolveTargets,
  buildCsp,
  buildOverride,
  nextPublicEnv,
  toWs,
  toHttp,
  DEFAULT_TARGETS,
} from './selfhost-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAURI_DIR = dirname(HERE)

const SELF_HOST = {
  OT_API_URL: 'https://api.my-server.tld',
  OT_APP_URL: 'https://my-server.tld',
  OT_S3_URL: 'https://s3.my-server.tld',
  OT_LIVEKIT_URL: 'wss://lk.my-server.tld',
}

/** Split a CSP into `{directive: 'sources…'}` so tests can assert per-directive. */
const directives = (csp) =>
  Object.fromEntries(
    csp.split(';').map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/)
      return [name, rest.join(' ')]
    })
  )

describe('.env parsing', () => {
  test('reads KEY=VALUE, ignoring comments and blank lines', () => {
    const out = parseEnvFile('# comment\n\nOT_API_URL=https://a.tld\n  OT_ENABLE_GIF = false \n')
    assert.deepEqual(out, { OT_API_URL: 'https://a.tld', OT_ENABLE_GIF: 'false' })
  })

  test('strips surrounding quotes but keeps `=` inside a value', () => {
    const out = parseEnvFile('OT_API_URL="https://a.tld"\nOT_TOKEN=ab=cd==\n')
    assert.equal(out.OT_API_URL, 'https://a.tld')
    assert.equal(out.OT_TOKEN, 'ab=cd==')
  })

  test('survives CRLF (the file is edited on Windows as often as not)', () => {
    const out = parseEnvFile('OT_API_URL=https://a.tld\r\nOT_S3_URL=https://s.tld\r\n')
    assert.equal(out.OT_API_URL, 'https://a.tld')
    assert.equal(out.OT_S3_URL, 'https://s.tld')
  })

  test('a commented-out assignment stays commented out', () => {
    assert.deepEqual(parseEnvFile('#OT_API_URL=https://leak.tld\n'), {})
  })
})

describe('resolving the target server', () => {
  test('no .env at all builds the public maintainer app', () => {
    const t = resolveTargets({})
    assert.equal(t.api, DEFAULT_TARGETS.api)
    assert.equal(t.app, DEFAULT_TARGETS.app)
    assert.equal(t.s3, DEFAULT_TARGETS.s3)
  })

  test('a trailing slash never leaks into a CSP source', () => {
    const t = resolveTargets({ ...SELF_HOST, OT_API_URL: 'https://api.my-server.tld/' })
    assert.equal(t.api, 'https://api.my-server.tld')
    assert.ok(!buildCsp(t).includes('.tld/'), 'CSP sources must be bare origins')
  })

  /**
   * A missing scheme is the single most likely thing an operator types. It used
   * to sail straight into the CSP, where it matches nothing — the installer
   * built fine and the app could not talk to its own server.
   */
  test('a URL with no scheme fails the build instead of shipping a dead app', () => {
    assert.throws(() => resolveTargets({ ...SELF_HOST, OT_API_URL: 'api.my-server.tld' }), /OT_API_URL/)
  })

  test('a URL with a path fails — CSP sources are origins, not endpoints', () => {
    assert.throws(() => resolveTargets({ ...SELF_HOST, OT_API_URL: 'https://api.my-server.tld/api' }), /bare origin/)
  })

  test('an empty value falls back to the default rather than emptying the allow-list', () => {
    assert.equal(resolveTargets({ ...SELF_HOST, OT_S3_URL: '' }).s3, DEFAULT_TARGETS.s3)
  })

  test('LiveKit is only demanded when calls are enabled', () => {
    assert.doesNotThrow(() =>
      resolveTargets({ ...SELF_HOST, OT_ENABLE_CALLS: 'false', OT_LIVEKIT_URL: 'nonsense' })
    )
    assert.throws(() => resolveTargets({ ...SELF_HOST, OT_LIVEKIT_URL: 'nonsense' }), /OT_LIVEKIT_URL/)
  })
})

describe('CSP allow-list', () => {
  test('a self-host build allows the operator hosts and NOT the public instance', () => {
    const csp = buildCsp(resolveTargets(SELF_HOST))
    assert.ok(csp.includes('https://api.my-server.tld'))
    assert.ok(!csp.includes('onetothree.ru'), 'the maintainer instance must not stay in a self-host CSP')
  })

  test('connect-src carries the WebSocket origin, or the app loads and never syncs', () => {
    const d = directives(buildCsp(resolveTargets(SELF_HOST)))
    assert.ok(d['connect-src'].includes('wss://api.my-server.tld'))
    assert.ok(d['connect-src'].includes('https://s3.my-server.tld'))
  })

  test('calls off drops LiveKit from connect-src', () => {
    const on = directives(buildCsp(resolveTargets(SELF_HOST)))['connect-src']
    const off = directives(buildCsp(resolveTargets({ ...SELF_HOST, OT_ENABLE_CALLS: '0' })))['connect-src']
    assert.ok(on.includes('wss://lk.my-server.tld') && on.includes('https://lk.my-server.tld'))
    assert.ok(!off.includes('lk.my-server.tld'))
  })

  test('gif off drops every third-party GIF host from every directive', () => {
    const csp = buildCsp(resolveTargets({ ...SELF_HOST, OT_ENABLE_GIF: 'no' }))
    for (const host of ['giphy.com', 'tenor.com', 'tenor.googleapis.com']) {
      assert.ok(!csp.includes(host), `${host} must be gone when GIF is off`)
    }
  })

  /**
   * Production allows both, and the desktop CSP had drifted without them:
   * MediaPipe's camera effects need wasm, and the call relay's AudioWorklet is
   * loaded from a blob:. Neither errors visibly — the app quietly falls back.
   */
  test('script-src carries what the wasm and worklet paths need', () => {
    const d = directives(buildCsp(resolveTargets(SELF_HOST)))
    assert.ok(d['script-src'].includes("'wasm-unsafe-eval'"))
    assert.ok(d['script-src'].includes('blob:'))
  })

  test("connect-src carries Tauri's own IPC endpoints", () => {
    const d = directives(buildCsp(resolveTargets(SELF_HOST)))
    assert.ok(d['connect-src'].includes('ipc://localhost'))
    assert.ok(d['connect-src'].includes('http://ipc.localhost'), 'Windows WebView2 uses http://ipc.localhost')
  })

  test('the committed maintainer CSP grants the same things as the generated one', () => {
    const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    const shipped = directives(conf.app.security.csp)
    for (const token of ["'wasm-unsafe-eval'", 'blob:']) {
      assert.ok(shipped['script-src'].includes(token), `tauri.conf.json script-src is missing ${token}`)
    }
    assert.ok(shipped['connect-src'].includes('ipc://localhost'))
  })

  test('the hardening directives are never dropped', () => {
    const d = directives(buildCsp(resolveTargets(SELF_HOST)))
    assert.equal(d['frame-ancestors'], "'none'")
    assert.equal(d['object-src'], "'none'")
    assert.equal(d['worker-src'], "'self' blob:")
  })

  test('no directive ends up with doubled or trailing whitespace', () => {
    const csp = buildCsp(resolveTargets({ ...SELF_HOST, OT_ENABLE_GIF: '0', OT_ENABLE_CALLS: '0' }))
    assert.ok(!/\s{2}/.test(csp), csp)
    assert.ok(!/\s;/.test(csp), csp)
  })

  test('ws/http derivation covers both plain and TLS origins', () => {
    assert.equal(toWs('https://a.tld'), 'wss://a.tld')
    assert.equal(toWs('http://a.tld'), 'ws://a.tld')
    assert.equal(toHttp('wss://a.tld'), 'https://a.tld')
    assert.equal(toHttp('ws://a.tld'), 'http://a.tld')
  })

  /**
   * A plain-HTTP LAN server is a legitimate self-host target; the CSP has to
   * follow it rather than silently keeping https-only sources.
   */
  test('a plain-http LAN target produces ws:// and http:// sources', () => {
    const d = directives(
      buildCsp(
        resolveTargets({
          OT_API_URL: 'http://192.168.1.50:8080',
          OT_APP_URL: 'http://192.168.1.50:8443',
          OT_S3_URL: 'http://192.168.1.50:9000',
          OT_ENABLE_CALLS: '0',
        })
      )
    )
    assert.ok(d['connect-src'].includes('http://192.168.1.50:8080'))
    assert.ok(d['connect-src'].includes('ws://192.168.1.50:8080'))
  })
})

describe('the frontend and the CSP must agree', () => {
  /**
   * The bug this pins, and the reason this file exists.
   *
   * tauri.conf.json runs `npm run build:client:export` as `beforeBuildCommand`,
   * and that script hardcodes NEXT_PUBLIC_API_URL=https://api.onetothree.ru.
   * `tauri build` runs the hook AFTER build-selfhost.mjs has already exported
   * the frontend for the operator's server — so it silently overwrote
   * client/out with a public-instance build, which the freshly generated
   * self-host CSP then blocked from reaching anything. `npm run build:selfhost`
   * produced an installer whose app was dead on arrival, with no error anywhere.
   */
  test('the override neutralises beforeBuildCommand so Tauri cannot re-export', () => {
    const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    if (!conf.build?.beforeBuildCommand) return // nothing to neutralise; invariant holds trivially
    assert.equal(
      buildOverride(resolveTargets(SELF_HOST)).build?.beforeBuildCommand,
      '',
      'tauri.conf.json still re-exports the frontend — the override must clear it'
    )
  })

  test('every NEXT_PUBLIC_* origin is allowed by the CSP built alongside it', () => {
    const t = resolveTargets(SELF_HOST)
    const d = directives(buildCsp(t))
    const next = nextPublicEnv(t)
    assert.ok(d['connect-src'].includes(next.NEXT_PUBLIC_API_URL))
    assert.ok(d['connect-src'].includes(toWs(next.NEXT_PUBLIC_WS_ORIGIN)))
  })

  test('the override still carries the CSP it was generated for', () => {
    const t = resolveTargets(SELF_HOST)
    assert.equal(buildOverride(t).app.security.csp, buildCsp(t))
  })
})

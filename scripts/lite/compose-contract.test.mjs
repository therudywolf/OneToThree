/**
 * The installer and the compose file have to agree on variable names.
 *
 * `buildEnv()` writes `.env.lite`; `docker-compose.lite.yml` interpolates from
 * it. Nothing checked that the two lists match, and the failure is quiet in
 * both directions: a variable compose needs but the installer never writes
 * lands in the container as an empty string (a feature flag silently off, a
 * secret silently blank), and a variable the installer writes that compose
 * never reads is config the operator believes is applied and is not.
 *
 * Renaming one side is a one-line change that nothing else in the repo notices.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FEATURES, computeModeConfig, buildEnv, resolveVapid } from './lite-core.mjs'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const compose = readFileSync(join(REPO, 'docker-compose.lite.yml'), 'utf8')

/**
 * Every `${OT_*}` in the compose file, with whether it carries a fallback.
 * Forms: `${X}`, `${X:-d}`, `${X-d}`, `${X:?msg}`, `${X?msg}`. Only the `-`
 * forms supply a value; `:?` demands one, and a bare `${X}` silently becomes ''.
 */
const referenced = new Map()
for (const m of compose.matchAll(/\$\{(OT_[A-Z0-9_]+)([:-]?[-?][^}]*)?\}/g)) {
  const modifier = m[2] || ''
  const hasFallback = /^:?-/.test(modifier)
  referenced.set(m[1], (referenced.get(m[1]) ?? false) || hasFallback)
}

const flagsFor = (over = {}) =>
  Object.fromEntries(FEATURES.map((f) => [f.key, over[f.key] ?? (f.on ? '1' : '0')]))

/** What a default `npm run lite` (local mode, default checkboxes) produces. */
const defaultInstall = buildEnv({ cfg: computeModeConfig('local', {}), flags: flagsFor() })

/** Everything the wizard can produce with every feature turned on. */
const maximalInstall = buildEnv({
  cfg: computeModeConfig('domain', { domain: 'chat.example.com' }),
  flags: flagsFor(Object.fromEntries(FEATURES.map((f) => [f.key, '1']))),
  vapid: resolveVapid({ existing: {} }),
  livekit: { url: 'wss://lk.example.com', key: 'k', secret: 's' },
  s3PublicUrl: 'https://s3.example.com',
})

/**
 * Written for the installer's own bookkeeping (re-run detection), deliberately
 * not consumed by compose. Anything else appearing here is a real orphan.
 */
const INSTALLER_ONLY = new Set(['OT_MODE'])

describe('installer ↔ docker-compose.lite.yml', () => {
  test('the compose file really is parameterised (guards this test itself)', () => {
    assert.ok(referenced.size > 15, `only found ${referenced.size} OT_* references — did the regex rot?`)
    assert.ok(referenced.has('OT_JWT_SECRET'), 'expected the API secrets to come from .env.lite')
  })

  test('every variable compose requires is written by the installer', () => {
    const missing = [...referenced]
      .filter(([, hasFallback]) => !hasFallback)
      .map(([name]) => name)
      .filter((name) => !(name in maximalInstall))
    assert.deepEqual(missing, [], `compose interpolates these with no fallback, but .env.lite never has them`)
  })

  test('a default install fills every required variable with a real value', () => {
    const blank = [...referenced]
      .filter(([, hasFallback]) => !hasFallback)
      .map(([name]) => name)
      .filter((name) => !String(defaultInstall[name] ?? '').length)
    assert.deepEqual(blank, [], 'these would reach the container as an empty string')
  })

  test('nothing the installer writes is silently ignored by compose', () => {
    const orphans = Object.keys(maximalInstall).filter(
      (k) => !referenced.has(k) && !INSTALLER_ONLY.has(k)
    )
    assert.deepEqual(orphans, [], 'written to .env.lite but never read — the operator sets it for nothing')
  })

  test('every feature checkbox reaches the API as its own variable', () => {
    for (const f of FEATURES) {
      const name = `OT_ENABLE_${f.key}`
      assert.ok(name in maximalInstall, `${f.key} has no ${name}`)
      assert.ok(referenced.has(name), `${name} is written but docker-compose.lite.yml never passes it on`)
    }
  })

  /**
   * Publishing Postgres, Redis or MinIO's console on 0.0.0.0 turns a one-command
   * self-host into an exposed database. Only the reverse proxy (and the MinIO
   * object port, which media links need) may be published.
   */
  test('no internal service publishes a port outside the loopback binding', () => {
    const services = compose.split(/\n {2}(?=[a-z0-9_-]+:)/)
    let examined = 0
    for (const chunk of services) {
      const name = /^\s*([a-z0-9_-]+):/.exec(chunk)?.[1]
      if (!name || !/^\s{4,}ports:/m.test(chunk)) continue
      const ports = chunk.slice(chunk.search(/^\s{4,}ports:/m)).split(/\n\s{4}(?=[a-z])/)[0]
      for (const line of ports.split('\n').filter((l) => /^\s*-\s/.test(l))) {
        examined++
        assert.match(
          line,
          /\$\{OT_BIND[:}]/,
          `service "${name}" publishes ${line.trim()} without the OT_BIND host prefix`
        )
      }
    }
    // Without this, a parsing change turns the whole check into a silent pass.
    assert.ok(examined >= 3, `expected to examine the published ports, saw ${examined}`)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { authorizeMetrics, metricsToken, renderMetrics } from '../lib/metrics.js'

/**
 * The metrics endpoint on a private messenger.
 *
 * What has to hold, in order of how badly each would hurt:
 *
 *  1. **Off means absent.** With no `METRICS_TOKEN` the route must not exist —
 *     not "exists and 401s", which would confirm the instance to anyone probing.
 *  2. **A wrong token is indistinguishable from "no such endpoint"**, for the
 *     same reason.
 *  3. **No per-user series.** A scrape must not become a way to enumerate who
 *     is online, so the output carries counts and never a user id or handle.
 *  4. **A too-short token is treated as unset**, because a four-character
 *     secret that looks like protection is worse than none.
 */

const GOOD_TOKEN = 'a'.repeat(40)

describe('metrics endpoint', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    delete process.env.METRICS_TOKEN
  })

  it('is not registered at all when METRICS_TOKEN is unset', async () => {
    delete process.env.METRICS_TOKEN
    app = await buildApp()
    await app.ready()
    const res = await request(app.server).get('/metrics')
    expect(res.status).toBe(404)
  })

  it('treats a short token as unset rather than as weak protection', () => {
    process.env.METRICS_TOKEN = 'short'
    expect(metricsToken()).toBeNull()
    expect(authorizeMetrics('Bearer short')).toBe(false)
  })

  it('serves the exposition to a correct bearer and 404s everyone else', async () => {
    process.env.METRICS_TOKEN = GOOD_TOKEN
    app = await buildApp()
    await app.ready()

    const anonymous = await request(app.server).get('/metrics')
    expect(anonymous.status).toBe(404)

    const wrong = await request(app.server)
      .get('/metrics')
      .set('Authorization', `Bearer ${'b'.repeat(40)}`)
    expect(wrong.status).toBe(404)

    const ok = await request(app.server)
      .get('/metrics')
      .set('Authorization', `Bearer ${GOOD_TOKEN}`)
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toContain('text/plain')
    expect(ok.text).toContain('onetothree_build_info')
    expect(ok.text).toContain('onetothree_log_lines_total{level="warn"}')
    expect(ok.text).toContain('onetothree_ws_sockets')
  })

  it('exposes counts, never identities', () => {
    const out = renderMetrics({ version: '1.2.3', commit: 'deadbeef' })
    // Every sample line is `name{labels} value`; the only labels we emit are
    // build metadata and a log level. A uuid here would mean a per-user series.
    expect(out).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    )
    expect(out).toContain('version="1.2.3"')
    expect(out).toContain('commit="deadbeef"')
    for (const line of out.split('\n')) {
      if (!line || line.startsWith('#')) continue
      expect(line).toMatch(/^onetothree_[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?$/)
    }
  })

  it('escapes a hostile version string instead of breaking the format', () => {
    const out = renderMetrics({ version: 'x"y\\z', commit: null })
    expect(out).toContain('version="x\\"y\\\\z"')
    expect(out).toContain('commit="unknown"')
  })
})

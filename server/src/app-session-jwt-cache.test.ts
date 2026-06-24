import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'

// D12 regression: verifySessionJwt was run 2-3× per request (each an extra
// Redis denylist round-trip + a fresh JWT signature verify). The per-request
// `request.sessionJwt()` decorator must memoize the cookie-derived payload so
// repeated consumers (getHistoryCutoff, device-id lookups) share ONE verify.
describe('request.sessionJwt() per-request memoization (D12)', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    // Probe route that calls the decorator multiple times like the real
    // handlers do, and reports both the resolved subject and the call count.
    app.get('/__test/session-jwt-cache', async (request) => {
      const a = await request.sessionJwt()
      const b = await request.sessionJwt()
      const c = await request.sessionJwt()
      return { sub: a?.sub ?? null, sameRef: a === b && b === c }
    })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('verifies the JWT only once even when sessionJwt() is called repeatedly', async () => {
    const sub = randomUUID()
    const token = await app!.jwt.sign({
      sub,
      username: 'd12-user',
      device_id: randomUUID(),
      jti: randomUUID(),
    })

    // Spy on the underlying signature verification: a single request must
    // trigger at most ONE verify regardless of how many consumers ask.
    const verifySpy = vi.spyOn(app!.jwt, 'verify')

    const res = await app!.inject({
      method: 'GET',
      url: '/__test/session-jwt-cache',
      cookies: { fm_session: token },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { sub: string | null; sameRef: boolean }
    expect(body.sub).toBe(sub)
    // All three sessionJwt() calls returned the identical cached promise result.
    expect(body.sameRef).toBe(true)
    // The decorator memoized: exactly one signature verification for the request.
    expect(verifySpy).toHaveBeenCalledTimes(1)

    verifySpy.mockRestore()
  })

  it('returns null for a request without a session cookie', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: '/__test/session-jwt-cache',
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sub: string | null }).sub).toBeNull()
  })
})

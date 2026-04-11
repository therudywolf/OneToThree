import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

/**
 * Contract checks for QR device-link endpoints (no DB for unauthenticated paths).
 */
describe('auth QR routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('POST /api/auth/qr-generate returns 401 without session', async () => {
    const res = await request(app!.server)
      .post('/api/auth/qr-generate')
      .expect(401)
    expect(res.body.error).toBeTruthy()
  })

  it('POST /api/auth/qr-login returns 400 for invalid body', async () => {
    const res = await request(app!.server)
      .post('/api/auth/qr-login')
      .send({ token: 'not-a-uuid' })
      .expect(400)
    expect(res.body.error).toBe('INVALID_BODY')
  })

  it('POST /api/auth/qr-login returns 401 for unknown or expired token', async () => {
    const res = await request(app!.server)
      .post('/api/auth/qr-login')
      .send({ token: randomUUID() })
      .expect(401)
    expect(res.body.error).toBe('INVALID_OR_EXPIRED_TOKEN')
  })
})

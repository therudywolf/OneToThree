import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { saveQrLinkToken, _resetQrLinkStoreForTests } from '../lib/qr-link-store.js'
import { eq } from 'drizzle-orm'

const _require = createRequire(import.meta.url)
const otplib = _require('otplib') as {
  generateSecret(length?: number): string
}

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
    _resetQrLinkStoreForTests()
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

  it('POST /api/auth/qr-login returns 2FA pending payload for TOTP-protected users', async () => {
    const username = `qr${Date.now().toString(36)}`
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        totpSecret: otplib.generateSecret(),
        isTotpEnabled: true,
      })
      .returning({ id: users.id })

    const token = randomUUID()
    await saveQrLinkToken(token, {
      sub: created.id,
      username,
      exp: Date.now() + 60_000,
    })

    const res = await request(app!.server)
      .post('/api/auth/qr-login')
      .set('X-Client-Device-Id', 'vitest-qr-device')
      .send({ token })
      .expect(200)

    expect(res.body.requires2FA).toBe(true)
    expect(typeof res.body.pendingToken).toBe('string')
    expect(res.body.userId).toBe(created.id)

    await db.delete(users).where(eq(users.id, created.id))
    _resetQrLinkStoreForTests()
  })
})

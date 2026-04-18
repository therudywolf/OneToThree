import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { generateTotpCode, generateTotpSecret } from '../lib/totp.js'

describe('auth recovery routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('requires TOTP step-up for recovery setup when 2FA is enabled', async () => {
    const username = `r2fa${Date.now().toString(36)}`
    const secret = generateTotpSecret()
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        isTotpEnabled: true,
        totpSecret: secret,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: created.id, username: created.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      const missing = await request(app!.server)
        .post('/api/auth/recovery/setup')
        .set('Cookie', cookie)
        .expect(401)
      expect(missing.body.error).toBe('TOTP_STEP_UP_REQUIRED')

      const code = await generateTotpCode(secret)
      const ok = await request(app!.server)
        .post('/api/auth/recovery/setup')
        .set('Cookie', cookie)
        .set('X-TOTP-Code', code)
        .expect(200)
      expect(typeof ok.body.recovery_key).toBe('string')
      expect(typeof ok.body.recovery_key_set_at).toBe('string')
    } finally {
      await db.delete(users).where(eq(users.id, created.id))
    }
  })

  it('verifies recovery key for authenticated session', async () => {
    const username = `rkey${Date.now().toString(36)}`
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        isTotpEnabled: false,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: created.id, username: created.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      const setup = await request(app!.server)
        .post('/api/auth/recovery/setup')
        .set('Cookie', cookie)
        .expect(200)
      expect(typeof setup.body.recovery_key).toBe('string')

      const bad = await request(app!.server)
        .post('/api/auth/recovery/verify')
        .set('Cookie', cookie)
        .send({ recovery_key: 'bad-bad-bad-bad' })
        .expect(401)
      expect(bad.body.error).toBe('RECOVERY_KEY_INVALID')

      await request(app!.server)
        .post('/api/auth/recovery/verify')
        .set('Cookie', cookie)
        .send({ recovery_key: setup.body.recovery_key })
        .expect(200)
    } finally {
      await db.delete(users).where(eq(users.id, created.id))
    }
  })
})

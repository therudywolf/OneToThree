import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { generateTotpCode, generateTotpSecret } from '../lib/totp.js'

describe('users sensitive actions step-up', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('PATCH /api/users/me requires TOTP step-up for allow_device_linking when 2FA is enabled', async () => {
    const username = `stepup${Date.now().toString(36)}`
    const secret = generateTotpSecret()
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        totpSecret: secret,
        isTotpEnabled: true,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: created.id, username: created.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      const missing = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({ allow_device_linking: true })
        .expect(401)
      expect(missing.body.error).toBe('TOTP_STEP_UP_REQUIRED')

      const bad = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .set('X-TOTP-Code', '000000')
        .send({ allow_device_linking: true })
        .expect(401)
      expect(bad.body.error).toBe('TOTP_INVALID')

      const code = await generateTotpCode(secret)
      const ok = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .set('X-TOTP-Code', code)
        .send({ allow_device_linking: true })
        .expect(200)
      expect(ok.body.ok).toBe(true)
      expect(ok.body.allow_device_linking).toBe(true)

      const [after] = await db
        .select({ allowDeviceLinking: users.allowDeviceLinking })
        .from(users)
        .where(eq(users.id, created.id))
        .limit(1)

      expect(after?.allowDeviceLinking).toBe(true)
    } finally {
      await db.delete(users).where(eq(users.id, created.id))
    }
  })

  it('PATCH /api/users/me does not require step-up for allow_device_linking when 2FA is disabled', async () => {
    const username = `nostep${Date.now().toString(36)}`
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        isTotpEnabled: false,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: created.id, username: created.username, jti: randomUUID() })

    try {
      const res = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', `fm_session=${token}`)
        .send({ allow_device_linking: true })
        .expect(200)

      expect(res.body.ok).toBe(true)
      expect(res.body.allow_device_linking).toBe(true)
    } finally {
      await db.delete(users).where(eq(users.id, created.id))
    }
  })
})

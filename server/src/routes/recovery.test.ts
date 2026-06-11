import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'

function signNonceDerB64(nonce: string, privateKey: KeyObject) {
  const sign = createSign('SHA256')
  sign.update(nonce, 'utf8')
  sign.end()
  return sign.sign(privateKey).toString('base64')
}

describe('account recovery (Option A) routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('enable → challenge → complete returns the blob; wrong sig + unknown user both 401; disable revokes', async () => {
    const username = `rec${Date.now().toString(36)}`
    const nobody = `nob${Date.now().toString(36)}`
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const recoveryAuthPubJwk = JSON.stringify(publicKey.export({ format: 'jwk' }))
    const RECOVERY_BLOB = JSON.stringify({ v: 2, opaque: 'ciphertext-only' })

    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const [dev] = await db
      .insert(devices)
      .values({ userId: u.id, clientDeviceKey: `dev-${randomUUID()}`, deviceName: 'd', linkedAt: new Date() })
      .returning({ id: devices.id })

    const token = await app!.jwt.sign({ sub: u.id, username: u.username, device_id: dev.id, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      // Not enabled initially.
      const s0 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s0.body.enabled).toBe(false)

      // Enable (no TOTP on this account → step-up passes through).
      const en = await request(app!.server)
        .post('/api/users/me/recovery/enable')
        .set('Cookie', cookie)
        .send({ recovery_vault_blob: RECOVERY_BLOB, recovery_auth_pub_jwk: recoveryAuthPubJwk })
        .expect(200)
      expect(en.body.require_totp).toBe(false)

      const s1 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s1.body.enabled).toBe(true)

      // Recover (unauthenticated): prove the phrase by signing the nonce.
      const ch = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const done = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: ch.body.nonce, signature: signNonceDerB64(ch.body.nonce, privateKey) })
        .expect(200)
      expect(done.body.recovery_vault_blob).toBe(RECOVERY_BLOB)

      // A signature over the wrong message must not verify.
      const chBad = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const bad = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: chBad.body.nonce, signature: signNonceDerB64('not-the-nonce', privateKey) })
        .expect(401)
      expect(bad.body.error).toBe('SIGNATURE_INVALID')

      // Unknown account fails with the SAME shape (no enumeration leak).
      const chNo = await request(app!.server).post('/api/auth/recovery/challenge').send({ username: nobody }).expect(200)
      const no = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username: nobody, nonce: chNo.body.nonce, signature: signNonceDerB64(chNo.body.nonce, privateKey) })
        .expect(401)
      expect(no.body.error).toBe('SIGNATURE_INVALID')

      // Disable revokes recovery entirely.
      await request(app!.server).post('/api/users/me/recovery/disable').set('Cookie', cookie).expect(200)
      const s2 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s2.body.enabled).toBe(false)

      const chGone = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: chGone.body.nonce, signature: signNonceDerB64(chGone.body.nonce, privateKey) })
        .expect(401)
    } finally {
      await db.delete(devices).where(eq(devices.userId, u.id))
      await db.delete(users).where(inArray(users.id, [u.id]))
    }
  })
})

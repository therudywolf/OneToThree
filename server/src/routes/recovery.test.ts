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

function p256Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { priv: privateKey, pubJwk: JSON.stringify(publicKey.export({ format: 'jwk' })) }
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

  // The vault-unlock proof: sign a fresh setup-challenge nonce with the login
  // identity key (proves the caller can unlock the vault, not just hold a cookie).
  async function vaultProof(cookie: string, identityPriv: KeyObject) {
    const ch = await request(app!.server)
      .get('/api/users/me/recovery/setup-challenge')
      .set('Cookie', cookie)
      .expect(200)
    return { proof_nonce: ch.body.nonce, proof_signature: signNonceDerB64(ch.body.nonce, identityPriv) }
  }

  it('enable (proof-gated) → challenge → complete returns the blob; bad inputs 401; disable revokes', async () => {
    const username = `rec${Date.now().toString(36)}`
    const nobody = `nob${Date.now().toString(36)}`
    const id = p256Keypair() // login identity — signs the vault-unlock proof
    const rec = p256Keypair() // recovery phrase key — signs the recovery challenge
    const RECOVERY_BLOB = JSON.stringify({ v: 2, opaque: 'ciphertext-only' })

    const [u] = await db
      .insert(users)
      .values({ username, publicKeyJwk: id.pubJwk })
      .returning({ id: users.id, username: users.username })
    const [dev] = await db
      .insert(devices)
      .values({ userId: u.id, clientDeviceKey: `dev-${randomUUID()}`, deviceName: 'd', linkedAt: new Date() })
      .returning({ id: devices.id })
    const cookie = `fm_session=${await app!.jwt.sign({ sub: u.id, username: u.username, device_id: dev.id, jti: randomUUID() })}`

    try {
      const s0 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s0.body.enabled).toBe(false)

      // Enabling without a valid vault-unlock proof is rejected.
      await request(app!.server)
        .post('/api/users/me/recovery/enable')
        .set('Cookie', cookie)
        .send({ recovery_vault_blob: RECOVERY_BLOB, recovery_auth_pub_jwk: rec.pubJwk, proof_nonce: 'x', proof_signature: 'y' })
        .expect(401)

      const en = await request(app!.server)
        .post('/api/users/me/recovery/enable')
        .set('Cookie', cookie)
        .send({ recovery_vault_blob: RECOVERY_BLOB, recovery_auth_pub_jwk: rec.pubJwk, ...(await vaultProof(cookie, id.priv)) })
        .expect(200)
      expect(en.body.require_totp).toBe(false)

      const s1 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s1.body.enabled).toBe(true)

      // Recover (unauthenticated): prove the phrase by signing the nonce.
      const ch = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const done = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: ch.body.nonce, signature: signNonceDerB64(ch.body.nonce, rec.priv) })
        .expect(200)
      expect(done.body.recovery_vault_blob).toBe(RECOVERY_BLOB)

      // A signature over the wrong message must not verify.
      const chBad = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const bad = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: chBad.body.nonce, signature: signNonceDerB64('not-the-nonce', rec.priv) })
        .expect(401)
      expect(bad.body.error).toBe('SIGNATURE_INVALID')

      // Unknown account fails with the SAME shape (no enumeration leak).
      const chNo = await request(app!.server).post('/api/auth/recovery/challenge').send({ username: nobody }).expect(200)
      const no = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username: nobody, nonce: chNo.body.nonce, signature: signNonceDerB64(chNo.body.nonce, rec.priv) })
        .expect(401)
      expect(no.body.error).toBe('SIGNATURE_INVALID')

      // Disable is also proof-gated; afterwards recovery is gone.
      await request(app!.server)
        .post('/api/users/me/recovery/disable')
        .set('Cookie', cookie)
        .send(await vaultProof(cookie, id.priv))
        .expect(200)
      const s2 = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(s2.body.enabled).toBe(false)

      const chGone = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: chGone.body.nonce, signature: signNonceDerB64(chGone.body.nonce, rec.priv) })
        .expect(401)
    } finally {
      await db.delete(devices).where(eq(devices.userId, u.id))
      await db.delete(users).where(inArray(users.id, [u.id]))
    }
  })

  it('does not leak ban state before the phrase is proven; reveals it only after', async () => {
    const username = `recb${Date.now().toString(36)}`
    const rec = p256Keypair()
    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        recoveryVaultBlob: JSON.stringify({ v: 2, opaque: 'x' }),
        recoveryAuthPubJwk: rec.pubJwk,
        isBanned: true,
      })
      .returning({ id: users.id })
    try {
      const ch1 = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const bad = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: ch1.body.nonce, signature: signNonceDerB64('not-the-nonce', rec.priv) })
        .expect(401)
      expect(bad.body.error).toBe('SIGNATURE_INVALID')

      const ch2 = await request(app!.server).post('/api/auth/recovery/challenge').send({ username }).expect(200)
      const good = await request(app!.server)
        .post('/api/auth/recovery/complete')
        .send({ username, nonce: ch2.body.nonce, signature: signNonceDerB64(ch2.body.nonce, rec.priv) })
        .expect(401)
      expect(good.body.error).toBe('BANNED_USER')
    } finally {
      await db.delete(users).where(inArray(users.id, [u.id]))
    }
  })

  it('refuses require_totp when the account has no TOTP (prevents self-lock)', async () => {
    const username = `rect${Date.now().toString(36)}`
    const id = p256Keypair()
    const rec = p256Keypair()
    const [u] = await db
      .insert(users)
      .values({ username, publicKeyJwk: id.pubJwk })
      .returning({ id: users.id, username: users.username })
    const [dev] = await db
      .insert(devices)
      .values({ userId: u.id, clientDeviceKey: `d-${randomUUID()}`, deviceName: 'd', linkedAt: new Date() })
      .returning({ id: devices.id })
    const cookie = `fm_session=${await app!.jwt.sign({ sub: u.id, username: u.username, device_id: dev.id, jti: randomUUID() })}`
    try {
      const en = await request(app!.server)
        .post('/api/users/me/recovery/enable')
        .set('Cookie', cookie)
        .send({
          recovery_vault_blob: JSON.stringify({ v: 2, opaque: 'x' }),
          recovery_auth_pub_jwk: rec.pubJwk,
          require_totp: true,
          ...(await vaultProof(cookie, id.priv)),
        })
        .expect(200)
      expect(en.body.require_totp).toBe(false)
      const st = await request(app!.server).get('/api/users/me/recovery/status').set('Cookie', cookie).expect(200)
      expect(st.body.require_totp).toBe(false)
    } finally {
      await db.delete(devices).where(eq(devices.userId, u.id))
      await db.delete(users).where(inArray(users.id, [u.id]))
    }
  })
})

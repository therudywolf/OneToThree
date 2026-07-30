import { randomUUID, webcrypto } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, users } from '../db/schema.js'

/**
 * A REAL ECDSA P-256 keypair. The ECDH-publish proof is a genuine signature
 * check, so a fixture with a made-up `x`/`y` cannot exercise it.
 */
async function makeLoginKeypair(): Promise<{ publicJwk: string; privateKey: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  const pub = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  return { publicJwk: JSON.stringify(pub), privateKey: pair.privateKey }
}

async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(nonce)
  )
  return Buffer.from(new Uint8Array(sig)).toString('base64')
}

describe('users device ECDH publishing', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('PATCH /api/users/me publishes ecdh key to the current device record', async () => {
    const username = `ecdh${Date.now().toString(36)}`
    const login = await makeLoginKeypair()
    const [user] = await db
      .insert(users)
      .values({ username, publicKeyJwk: login.publicJwk })
      .returning({ id: users.id, username: users.username })

    const [device] = await db
      .insert(devices)
      .values({
        userId: user.id,
        clientDeviceKey: `device-${randomUUID()}`,
        deviceName: 'ECDH publish test',
      })
      .returning({ id: devices.id })

    const token = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      device_id: device.id,
      jti: randomUUID(),
    })

    const ecdhPublicKeyJwk = JSON.stringify({
      kty: 'EC',
      crv: 'P-256',
      x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
      y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
    })

    const cookie = `fm_session=${token}`

    // A bare session cookie must NOT be able to swap this key — it decides who
    // every peer encrypts to, so without the proof a stolen session silently
    // redirects the victim's incoming messages to the attacker.
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ ecdh_public_key_jwk: ecdhPublicKeyJwk })
      .expect(400)

    // A signature over a nonce the server never issued is refused too.
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: randomUUID(),
        proof_signature: await signNonce(login.privateKey, 'some-other-nonce'),
      })
      .expect(403)

    const chal = await request(app!.server)
      .get('/api/users/me/ecdh/publish-challenge')
      .set('Cookie', cookie)
      .expect(200)
    const nonce = chal.body.nonce as string

    // ...and a real nonce signed by the WRONG key is refused.
    const attacker = await makeLoginKeypair()
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: nonce,
        proof_signature: await signNonce(attacker.privateKey, nonce),
      })
      .expect(403)

    // That attempt consumed the nonce (single-use), so take a fresh one.
    const chal2 = await request(app!.server)
      .get('/api/users/me/ecdh/publish-challenge')
      .set('Cookie', cookie)
      .expect(200)
    const nonce2 = chal2.body.nonce as string
    const goodSig = await signNonce(login.privateKey, nonce2)

    const res = await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: nonce2,
        proof_signature: goodSig,
      })
      .expect(200)

    expect(res.body.ok).toBe(true)

    // Replaying that same proof must fail — the nonce is spent.
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: nonce2,
        proof_signature: goodSig,
      })
      .expect(403)

    // TWO OUTSTANDING CHALLENGES must both remain valid.
    //
    // Registration publishes the ECDH key from two places at once (crypto-login
    // right after /auth/verify, then activateVaultSession). With one challenge
    // slot per user the second GET overwrote the first nonce and BOTH publishes
    // then 403'd — so on a live prod registration the key was never published,
    // and every peer saw "this contact has no encryption keys yet". Found by the
    // multi-client E2E, not by any unit test.
    const c1 = await request(app!.server)
      .get('/api/users/me/ecdh/publish-challenge').set('Cookie', cookie).expect(200)
    const c2 = await request(app!.server)
      .get('/api/users/me/ecdh/publish-challenge').set('Cookie', cookie).expect(200)
    const n1 = c1.body.nonce as string
    const n2 = c2.body.nonce as string
    expect(n1).not.toBe(n2)

    // The OLDER one still works even though a newer challenge was issued after it.
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: n1,
        proof_signature: await signNonce(login.privateKey, n1),
      })
      .expect(200)

    // ...and so does the newer one; neither cancelled the other.
    await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        ecdh_public_key_jwk: ecdhPublicKeyJwk,
        proof_nonce: n2,
        proof_signature: await signNonce(login.privateKey, n2),
      })
      .expect(200)

    const [updatedDevice] = await db
      .select({ ecdhPublicKey: devices.ecdhPublicKey })
      .from(devices)
      .where(and(eq(devices.id, device.id), eq(devices.userId, user.id)))
      .limit(1)

    expect(updatedDevice?.ecdhPublicKey).toBe(ecdhPublicKeyJwk)

    await db.delete(devices).where(eq(devices.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  })

  it('GET /:userId/devices requires a shared chat (or self) — no cross-user enumeration', async () => {
    const mk = async (p: string) => {
      const [u] = await db
        .insert(users)
        .values({
          username: `${p}${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
          publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        })
        .returning({ id: users.id, username: users.username })
      return u
    }
    const a = await mk('idora')
    const b = await mk('idorb')
    const c = await mk('idorc')

    // A and B share a chat; C shares nothing.
    const [chat] = await db.insert(chats).values({ type: 'direct_e2e', name: null }).returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: a.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: b.id, encryptedGroupKey: null, role: 'member' },
    ])

    const aToken = await app!.jwt.sign({ sub: a.id, username: a.username, jti: randomUUID() })
    const cookie = `fm_session=${aToken}`

    // Self: allowed.
    await request(app!.server).get(`/api/users/${a.id}/devices`).set('Cookie', cookie).expect(200)
    // Shared chat: allowed.
    await request(app!.server).get(`/api/users/${b.id}/devices`).set('Cookie', cookie).expect(200)
    // No shared chat: forbidden.
    await request(app!.server).get(`/api/users/${c.id}/devices`).set('Cookie', cookie).expect(403)

    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(inArray(users.id, [a.id, b.id, c.id]))
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

const EPHEMERAL_PUBKEY = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
})

// A second, distinct valid P-256 public JWK for racing-submission tests.
const EPHEMERAL_PUBKEY_2 = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'kgR_PqO1bnQ8Kj0wT0AnTBJ4ZyHfL5b3pX8tUeYmKa0',
  y: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
})

describe('device-linking P2P rendezvous', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function authCookie(): Promise<{ cookie: string; userId: string }> {
    const [user] = await db
      .insert(users)
      .values({
        username: `rdv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    return { cookie: `fm_session=${token}`, userId: user.id }
  }

  it('creates a rendezvous and returns an id + claim secret', async () => {
    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
      .expect(200)
    expect(typeof res.body.rendezvous_id).toBe('string')
    expect(typeof res.body.claim_secret).toBe('string')
    expect(res.body.claim_secret.length).toBeGreaterThan(20)
  })

  it('rejects a private or malformed ephemeral key', async () => {
    const withPrivate = JSON.stringify({
      kty: 'EC',
      crv: 'P-256',
      x: 'abc',
      y: 'def',
      d: 'secret',
    })
    const a = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: withPrivate })
      .expect(400)
    expect(a.body.error).toBe('INVALID_EPHEMERAL_KEY')

    await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: 'not-json' })
      .expect(400)
  })

  it('runs the full create -> deposit -> claim handoff', async () => {
    const { cookie, userId } = await authCookie()
    try {
      const created = await request(app!.server)
        .post('/api/devices/link/rendezvous')
        .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
        .expect(200)
      const { rendezvous_id, claim_secret } = created.body as {
        rendezvous_id: string
        claim_secret: string
      }

      // Claim before deposit -> 425 NOT_READY, entry not consumed.
      const early = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/claim`)
        .send({ claim_secret })
        .expect(425)
      expect(early.body.error).toBe('NOT_READY')

      await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'ciphertext-encrypted-to-ephemeral-key' })
        .expect(200)

      const claimed = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/claim`)
        .send({ claim_secret })
        .expect(200)
      expect(claimed.body.enc_blob).toBe('ciphertext-encrypted-to-ephemeral-key')

      // One-time: a second claim finds nothing.
      await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/claim`)
        .send({ claim_secret })
        .expect(404)
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('rejects an unauthenticated deposit', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
      .expect(200)
    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${created.body.rendezvous_id}/deposit`)
      .send({ enc_blob: 'x' })
      .expect(401)
  })

  it('rejects deposit to an unknown rendezvous and a double deposit', async () => {
    const { cookie, userId } = await authCookie()
    try {
      const missing = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${randomUUID()}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'x' })
        .expect(404)
      expect(missing.body.error).toBe('RENDEZVOUS_NOT_FOUND')

      const created = await request(app!.server)
        .post('/api/devices/link/rendezvous')
        .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
        .expect(200)
      const id = created.body.rendezvous_id as string

      await request(app!.server)
        .post(`/api/devices/link/rendezvous/${id}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'first' })
        .expect(200)
      const dup = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${id}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'second' })
        .expect(409)
      expect(dup.body.error).toBe('RENDEZVOUS_ALREADY_DEPOSITED')
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('rejects a claim with the wrong claim secret', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
      .expect(200)
    const res = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${created.body.rendezvous_id}/claim`)
      .send({ claim_secret: 'wrong-secret' })
      .expect(403)
    expect(res.body.error).toBe('CLAIM_SECRET_INVALID')
  })

  // -------------------------------------------------------------------------
  // Mode B — existing device shows the QR, new device scans it.
  // -------------------------------------------------------------------------

  it('creates an empty (Mode B) rendezvous when no pubkey is supplied', async () => {
    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({})
      .expect(200)
    expect(typeof res.body.rendezvous_id).toBe('string')
    expect(typeof res.body.claim_secret).toBe('string')

    // status before any pubkey submission: key is null, not deposited.
    const { cookie, userId } = await authCookie()
    try {
      const status = await request(app!.server)
        .get(`/api/devices/link/rendezvous/${res.body.rendezvous_id}/status`)
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body.ephemeral_pubkey).toBeNull()
      expect(status.body.deposited).toBe(false)
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('runs the full Mode B create -> submit-pubkey -> status -> deposit -> claim handoff', async () => {
    const { cookie, userId } = await authCookie()
    try {
      const created = await request(app!.server)
        .post('/api/devices/link/rendezvous')
        .send({})
        .expect(200)
      const { rendezvous_id, claim_secret } = created.body as {
        rendezvous_id: string
        claim_secret: string
      }

      // Deposit before a pubkey is submitted -> 409 (no recipient key).
      const early = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'x' })
        .expect(409)
      expect(early.body.error).toBe('RENDEZVOUS_PUBKEY_MISSING')

      // New device submits its ephemeral pubkey using the QR claim secret.
      await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/submit-pubkey`)
        .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY, claim_secret })
        .expect(200)

      // Existing device polls status and now sees the submitted key.
      const status = await request(app!.server)
        .get(`/api/devices/link/rendezvous/${rendezvous_id}/status`)
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body.ephemeral_pubkey).toBe(EPHEMERAL_PUBKEY)
      expect(status.body.deposited).toBe(false)

      // Existing device deposits the encrypted vault after user confirmation.
      await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
        .set('Cookie', cookie)
        .send({ enc_blob: 'mode-b-ciphertext' })
        .expect(200)

      const claimed = await request(app!.server)
        .post(`/api/devices/link/rendezvous/${rendezvous_id}/claim`)
        .send({ claim_secret })
        .expect(200)
      expect(claimed.body.enc_blob).toBe('mode-b-ciphertext')
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('submit-pubkey is first-write-wins (a second submission is rejected)', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({})
      .expect(200)
    const { rendezvous_id, claim_secret } = created.body as {
      rendezvous_id: string
      claim_secret: string
    }

    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/submit-pubkey`)
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY, claim_secret })
      .expect(200)

    // An attacker who photographed the QR races a second key — rejected.
    const second = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/submit-pubkey`)
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY_2, claim_secret })
      .expect(409)
    expect(second.body.error).toBe('RENDEZVOUS_PUBKEY_ALREADY_SET')

    // The legitimately submitted key is the one that survives.
    const { cookie, userId } = await authCookie()
    try {
      const status = await request(app!.server)
        .get(`/api/devices/link/rendezvous/${rendezvous_id}/status`)
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body.ephemeral_pubkey).toBe(EPHEMERAL_PUBKEY)
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('submit-pubkey rejects the wrong claim secret', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({})
      .expect(200)
    const res = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${created.body.rendezvous_id}/submit-pubkey`)
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY, claim_secret: 'wrong-secret' })
      .expect(403)
    expect(res.body.error).toBe('CLAIM_SECRET_INVALID')
  })

  it('submit-pubkey rejects a private or malformed ephemeral key', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({})
      .expect(200)
    const { rendezvous_id, claim_secret } = created.body as {
      rendezvous_id: string
      claim_secret: string
    }
    const withPrivate = JSON.stringify({
      kty: 'EC',
      crv: 'P-256',
      x: 'abc',
      y: 'def',
      d: 'secret',
    })
    const res = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/submit-pubkey`)
      .send({ ephemeral_pubkey: withPrivate, claim_secret })
      .expect(400)
    expect(res.body.error).toBe('INVALID_EPHEMERAL_KEY')
  })

  it('submit-pubkey on a Mode A rendezvous is rejected (key already set)', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
      .expect(200)
    const res = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${created.body.rendezvous_id}/submit-pubkey`)
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY_2, claim_secret: created.body.claim_secret })
      .expect(409)
    expect(res.body.error).toBe('RENDEZVOUS_PUBKEY_ALREADY_SET')
  })

  it('status requires authentication', async () => {
    const created = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({})
      .expect(200)
    await request(app!.server)
      .get(`/api/devices/link/rendezvous/${created.body.rendezvous_id}/status`)
      .expect(401)
  })

  it('status 404s for an unknown rendezvous', async () => {
    const { cookie, userId } = await authCookie()
    try {
      const res = await request(app!.server)
        .get(`/api/devices/link/rendezvous/${randomUUID()}/status`)
        .set('Cookie', cookie)
        .expect(404)
      expect(res.body.error).toBe('RENDEZVOUS_NOT_FOUND')
    } finally {
      await db.delete(users).where(eq(users.id, userId))
    }
  })
})

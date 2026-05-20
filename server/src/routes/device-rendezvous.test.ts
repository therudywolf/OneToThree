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
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { identityKeys, oneTimePrekeys, signedPrekeys, users } from '../db/schema.js'

async function createUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

describe('keys routes', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('rejects bundle fetch for self', async () => {
    if (!dbAvailable) return
    const user = await createUser(`keys-self-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`
    try {
      const res = await request(app!.server)
        .get(`/api/keys/bundle/${user.id}`)
        .set('Cookie', cookie)
        .expect(400)
      expect(res.body.error).toBe('BUNDLE_FOR_SELF_FORBIDDEN')
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  it('returns no-store and pops one-time prekey from bundle', async () => {
    if (!dbAvailable) return
    const requester = await createUser(`keys-r-${Date.now().toString(36)}`)
    const target = await createUser(`keys-t-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: requester.id, username: requester.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    await db.insert(identityKeys).values({
      userId: target.id,
      signingPublicKey: 'A'.repeat(43),
      exchangePublicKey: 'B'.repeat(43),
      generation: 1,
    })
    await db.insert(signedPrekeys).values({
      userId: target.id,
      preKeyId: 1,
      publicKey: 'C'.repeat(43),
      signature: 'D'.repeat(86),
    })
    await db.insert(oneTimePrekeys).values({
      userId: target.id,
      preKeyId: 10,
      publicKey: 'E'.repeat(43),
    })

    try {
      const first = await request(app!.server)
        .get(`/api/keys/bundle/${target.id}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(first.headers['cache-control']).toBe('no-store')
      expect(first.body.one_time_prekey?.pre_key_id).toBe(10)

      const second = await request(app!.server)
        .get(`/api/keys/bundle/${target.id}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(second.body.one_time_prekey).toBeNull()
    } finally {
      await db.delete(oneTimePrekeys).where(eq(oneTimePrekeys.userId, target.id))
      await db.delete(signedPrekeys).where(eq(signedPrekeys.userId, target.id))
      await db.delete(identityKeys).where(eq(identityKeys.userId, target.id))
      await db
        .delete(users)
        .where(and(eq(users.id, requester.id)))
      await db
        .delete(users)
        .where(and(eq(users.id, target.id)))
    }
  })

  it('treats same-generation identity publish with identical keys as idempotent', async () => {
    if (!dbAvailable) return
    const user = await createUser(`keys-idem-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`
    const body = {
      signing_public_key: 'A'.repeat(43),
      exchange_public_key: 'B'.repeat(43),
      generation: 1,
    }

    try {
      await request(app!.server)
        .post('/api/keys/identity')
        .set('Cookie', cookie)
        .send(body)
        .expect(200)

      const repeated = await request(app!.server)
        .post('/api/keys/identity')
        .set('Cookie', cookie)
        .send(body)
        .expect(200)

      expect(repeated.body.ok).toBe(true)
      expect(repeated.body.unchanged).toBe(true)

      const rows = await db
        .select({
          generation: identityKeys.generation,
          signingPublicKey: identityKeys.signingPublicKey,
          exchangePublicKey: identityKeys.exchangePublicKey,
        })
        .from(identityKeys)
        .where(eq(identityKeys.userId, user.id))

      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        generation: 1,
        signingPublicKey: body.signing_public_key,
        exchangePublicKey: body.exchange_public_key,
      })
    } finally {
      await db.delete(identityKeys).where(eq(identityKeys.userId, user.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})

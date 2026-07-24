import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { pushSubscriptions, users } from '../db/schema.js'

describe('push routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('POST /api/push/subscribe rejects unauthenticated request', async () => {
    const res = await request(app!.server)
      .post('/api/push/subscribe')
      .send({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'k1', auth: 'a1' },
      })
      .expect(401)

    expect(res.body.error).toBe('UNAUTHORIZED')
  })

  it('subscribe upserts and unsubscribe removes subscription', async () => {
    const username = `push${Date.now().toString(36)}`
    const endpoint = `https://push.example/${randomUUID()}`

    const [user] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      await request(app!.server)
        .post('/api/push/subscribe')
        .set('Cookie', cookie)
        .send({
          endpoint,
          keys: { p256dh: 'k1', auth: 'a1' },
        })
        .expect(200)

      const [row1] = await db
        .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)))
        .limit(1)

      expect(row1).toBeTruthy()
      expect(row1?.p256dh).toBe('k1')
      expect(row1?.auth).toBe('a1')

      await request(app!.server)
        .post('/api/push/subscribe')
        .set('Cookie', cookie)
        .send({
          endpoint,
          keys: { p256dh: 'k2', auth: 'a2' },
        })
        .expect(200)

      const [row2] = await db
        .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)))
        .limit(1)

      expect(row2).toBeTruthy()
      expect(row2?.p256dh).toBe('k2')
      expect(row2?.auth).toBe('a2')

      await request(app!.server)
        .delete('/api/push/unsubscribe')
        .set('Cookie', cookie)
        .send({ endpoint })
        .expect(200)

      const [afterDelete] = await db
        .select({ endpoint: pushSubscriptions.endpoint })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)))
        .limit(1)

      expect(afterDelete).toBeUndefined()
    } finally {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  // SSRF regression: the stored endpoint is a URL the SERVER later POSTs to
  // (webpush.sendNotification), so an unvalidated one made /subscribe an
  // authenticated request-forgery primitive into the private network — with a
  // readable oracle, since a 410 deletes the subscription row.
  it('rejects push endpoints that point at internal or non-https targets', async () => {
    const username = `pushssrf${Date.now().toString(36)}`
    const [user] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    const hostile = [
      'http://push.example/plain-http',
      'https://127.0.0.1/loopback',
      'https://10.0.0.5/private-a',
      'https://192.168.1.10/private-c',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/v6-loopback',
      'https://2130706433/decimal-loopback',
      'file:///etc/passwd',
      'not-a-url-at-all',
    ]

    try {
      for (const endpoint of hostile) {
        const res = await request(app!.server)
          .post('/api/push/subscribe')
          .set('Cookie', cookie)
          .send({ endpoint, keys: { p256dh: 'k1', auth: 'a1' } })
        expect(
          res.status,
          `expected ${endpoint} to be refused, got ${res.status}`
        ).toBe(400)
        expect(res.body.error).toBe('INVALID_ENDPOINT')
      }

      // Nothing hostile was persisted.
      const rows = await db
        .select({ endpoint: pushSubscriptions.endpoint })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, user.id))
      expect(rows).toHaveLength(0)

      // A normal public endpoint still registers.
      await request(app!.server)
        .post('/api/push/subscribe')
        .set('Cookie', cookie)
        .send({
          endpoint: `https://push.example/${randomUUID()}`,
          keys: { p256dh: 'k1', auth: 'a1' },
        })
        .expect(200)
    } finally {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

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

describe('users profile/settings routes', () => {
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

  it('persists display_name and last_seen_privacy across settings and profile reads', async () => {
    if (!dbAvailable) return
    const user = await createUser(`profile-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    try {
      const updated = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({
          display_name: 'Display Name',
          last_seen_privacy: 'contacts',
        })
        .expect(200)

      expect(updated.body.display_name).toBe('Display Name')
      expect(updated.body.last_seen_privacy).toBe('contacts')

      const settings = await request(app!.server)
        .get('/api/users/me/settings')
        .set('Cookie', cookie)
        .expect(200)

      expect(settings.body.display_name).toBe('Display Name')
      expect(settings.body.last_seen_privacy).toBe('contacts')

      const profile = await request(app!.server)
        .get(`/api/users/${user.username}/profile`)
        .set('Cookie', cookie)
        .expect(200)

      expect(profile.body.username).toBe(user.username)
      expect(profile.body.display_name).toBe('Display Name')
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  it('hides a non-discoverable stranger behind the same 404 as an unknown handle', async () => {
    // GET /search gates on is_discoverable (default FALSE), but this route
    // resolved any handle for any caller: a wordlist enumerated shadow accounts
    // and each hit leaked their profile plus an online/last_seen oracle.
    if (!dbAvailable) return
    const viewer = await createUser(`viewer-${Date.now().toString(36)}`)
    const subject = await createUser(`subject-${Date.now().toString(36)}`)
    const cookie = `fm_session=${await app!.jwt.sign({ sub: viewer.id, username: viewer.username, jti: randomUUID() })}`

    try {
      const hidden = await request(app!.server)
        .get(`/api/users/${subject.username}/profile`)
        .set('Cookie', cookie)
        .expect(404)
      expect(hidden.body.error).toBe('USER_NOT_FOUND')

      // Opting in to discovery makes the profile resolvable again.
      await db.update(users).set({ isDiscoverable: true }).where(eq(users.id, subject.id))
      const shown = await request(app!.server)
        .get(`/api/users/${subject.username}/profile`)
        .set('Cookie', cookie)
        .expect(200)
      expect(shown.body.username).toBe(subject.username)
    } finally {
      await db.delete(users).where(eq(users.id, viewer.id))
      await db.delete(users).where(eq(users.id, subject.id))
    }
  })
})

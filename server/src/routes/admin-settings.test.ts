import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { instanceSettings, users } from '../db/schema.js'
import { invalidateInstanceSettingsCache } from '../lib/instance-settings.js'

/**
 * The runtime instance settings the admin panel writes.
 *
 * What these pin down, in order of how badly each would hurt if it broke:
 *
 *  1. **Only a creator may write.** These knobs decide whether strangers can
 *     create accounts on the instance; an ordinary admin who could re-open
 *     registration is a privilege-escalation path, not a convenience.
 *  2. **`null` clears rather than sets.** The panel's "Сбросить" must hand the
 *     knob back to `.env` — a version that wrote `0`/`false` instead would look
 *     identical in the UI and quietly pin the value forever.
 *  3. **An override actually takes effect**, i.e. the settings layer is read,
 *     not just stored: `/capabilities` reports what the panel last set.
 */

type Grp = 'creator' | 'admin' | 'regular'

async function createUser(username: string, group: Grp) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: randomUUID(),
        y: randomUUID(),
      }),
      role: group === 'creator' || group === 'admin' ? 'admin' : 'user',
      userGroup: group,
    })
    .returning({ id: users.id, username: users.username })
  return row!
}

describe('admin instance settings', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true
  const createdUserIds: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterEach(async () => {
    if (!dbAvailable) return
    await db.delete(instanceSettings)
    invalidateInstanceSettingsCache()
  })

  afterAll(async () => {
    if (dbAvailable && createdUserIds.length) {
      await db.delete(users).where(inArray(users.id, createdUserIds))
    }
    if (app) await app.close()
  })

  async function cookieFor(user: { id: string; username: string }) {
    const token = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      jti: randomUUID(),
    })
    return `fm_session=${token}`
  }

  async function mkUser(prefix: string, group: Grp) {
    const u = await createUser(`${prefix}-${randomUUID().slice(0, 8)}`, group)
    createdUserIds.push(u.id)
    return u
  }

  it('shows the whole resolution chain, with no override on a fresh instance', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator', 'creator')
    const res = await request(app!.server)
      .get('/api/admin/settings')
      .set('Cookie', await cookieFor(creator))
      .expect(200)

    const reg = (res.body.settings as { key: string }[]).find(
      (s) => s.key === 'open_registration'
    ) as
      | {
          override: unknown
          effective: unknown
          env_value: unknown
          default_value: unknown
        }
      | undefined
    expect(reg).toBeTruthy()
    expect(reg!.override).toBeNull()
    expect(reg!.effective).toBe(reg!.env_value)
    expect(res.body.feature_flags).toHaveProperty('guests')
  })

  it('refuses a non-creator admin (settings are creator-only)', async () => {
    if (!dbAvailable) return
    const admin = await mkUser('set-admin', 'admin')
    const res = await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', await cookieFor(admin))
      .send({ key: 'open_registration', value: false })
      .expect(403)
    expect(res.body.error).toBe('CREATOR_ONLY')
    const rows = await db.select().from(instanceSettings)
    expect(rows).toHaveLength(0)
  })

  it('refuses an unknown key and a wrongly-typed value', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator2', 'creator')
    const cookie = await cookieFor(creator)
    await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', cookie)
      .send({ key: 'definitely_not_a_setting', value: true })
      .expect(404)
    await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', cookie)
      .send({ key: 'open_registration', value: 7 })
      .expect(400)
  })

  it('clamps an out-of-range integer instead of storing it raw', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator3', 'creator')
    const res = await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', await cookieFor(creator))
      .send({ key: 'guest_meeting_seats', value: 9999 })
      .expect(200)
    expect(res.body.setting.effective).toBe(50)
    expect(res.body.setting.override).toBe(50)
  })

  it('an override changes what the server reports, and null hands the knob back to env', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator4', 'creator')
    const cookie = await cookieFor(creator)

    await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', cookie)
      .send({ key: 'open_registration', value: false })
      .expect(200)

    // The capability probe is the surface every client reads; if the override
    // did not reach it, the "create account" tab stays visible on a server that
    // now refuses to create accounts.
    const closed = await request(app!.server).get('/api/capabilities').expect(200)
    expect(closed.body.features.openRegistration).toBe(false)

    const cleared = await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', cookie)
      .send({ key: 'open_registration', value: null })
      .expect(200)
    expect(cleared.body.setting.override).toBeNull()
    expect(await db.select().from(instanceSettings)).toHaveLength(0)

    const reopened = await request(app!.server).get('/api/capabilities').expect(200)
    expect(reopened.body.features.openRegistration).toBe(true)
  })

  it('/instance answers what the operator would otherwise SSH for', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator5', 'creator')
    const res = await request(app!.server)
      .get('/api/admin/instance')
      .set('Cookie', await cookieFor(creator))
      .expect(200)
    expect(res.body.health.db).toBe(true)
    expect(res.body.node_version).toBe(process.version)
    // At least the creator this test just made.
    expect(res.body.creator_count).toBeGreaterThanOrEqual(1)
  })

  it('a plain user reaches neither endpoint', async () => {
    if (!dbAvailable) return
    const plain = await mkUser('set-plain', 'regular')
    const cookie = await cookieFor(plain)
    await request(app!.server).get('/api/admin/settings').set('Cookie', cookie).expect(403)
    await request(app!.server).get('/api/admin/instance').set('Cookie', cookie).expect(403)
  })

  it('closing registration actually blocks account creation', async () => {
    if (!dbAvailable) return
    const creator = await mkUser('set-creator6', 'creator')
    await request(app!.server)
      .patch('/api/admin/settings')
      .set('Cookie', await cookieFor(creator))
      .send({ key: 'open_registration', value: false })
      .expect(200)

    const username = `newcomer-${randomUUID().slice(0, 8)}`
    const challenge = await request(app!.server)
      .post('/api/auth/challenge')
      .send({ username })
    // A closed instance still issues a challenge (it must not leak whether the
    // handle exists); the refusal lands on verify, where a key would be stored.
    expect(challenge.status).toBe(200)

    const res = await request(app!.server)
      .post('/api/auth/verify')
      .send({
        username,
        nonce: challenge.body.nonce,
        signature: 'AAAA',
        public_key_jwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('REGISTRATION_DISABLED')
    expect(
      await db.select().from(users).where(eq(users.username, username))
    ).toHaveLength(0)
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, users } from '../db/schema.js'

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
    const [user] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
      })
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

    const res = await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', `fm_session=${token}`)
      .send({ ecdh_public_key_jwk: ecdhPublicKeyJwk })
      .expect(200)

    expect(res.body.ok).toBe(true)

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

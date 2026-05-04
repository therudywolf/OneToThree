import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chats, devices, messageDeliveries, messages, users } from '../db/schema.js'

describe('users devices reauthorize route', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('clears revoked state and stale keys before a device relinks', async () => {
    const username = `reauth${Date.now().toString(36)}`
    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        isTotpEnabled: false,
      })
      .returning({ id: users.id, username: users.username })

    const [d] = await db
      .insert(devices)
      .values({
        userId: u.id,
        clientDeviceKey: `revoked-${randomUUID()}`,
        deviceName: 'Revoked test device',
        isMaster: false,
        revokedAt: new Date(),
        e2eePublicKey: JSON.stringify({ old: 'signing' }),
        ecdhPublicKey: JSON.stringify({ old: 'ecdh' }),
        linkedAt: new Date(),
        historySyncEnabledAt: new Date(),
      })
      .returning({ id: devices.id })

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })

    const [msg] = await db
      .insert(messages)
      .values({
        chatId: chat.id,
        senderId: u.id,
        content: 'stale-delivery',
        iv: 'iv',
      })
      .returning({ id: messages.id })
    await db.insert(messageDeliveries).values({
      messageId: msg.id,
      deviceId: d.id,
      userId: u.id,
      ciphertext: 'old',
      iv: 'old-iv',
    })

    const token = await app!.jwt.sign({
      sub: u.id,
      username: u.username,
      jti: randomUUID(),
    })

    try {
      const res = await request(app!.server)
        .post(`/api/users/me/devices/${d.id}/reauthorize`)
        .set('Cookie', `fm_session=${token}`)
        .expect(200)

      expect(res.body).toMatchObject({
        ok: true,
        device_id: d.id,
        requires_relink: true,
      })

      const [after] = await db
        .select({
          revokedAt: devices.revokedAt,
          e2eePublicKey: devices.e2eePublicKey,
          ecdhPublicKey: devices.ecdhPublicKey,
          linkedAt: devices.linkedAt,
          historySyncEnabledAt: devices.historySyncEnabledAt,
        })
        .from(devices)
        .where(eq(devices.id, d.id))
        .limit(1)
      expect(after?.revokedAt).toBeNull()
      expect(after?.e2eePublicKey).toBeNull()
      expect(after?.ecdhPublicKey).toBeNull()
      expect(after?.linkedAt).toBeNull()
      expect(after?.historySyncEnabledAt).toBeNull()

      const deliveries = await db
        .select({ messageId: messageDeliveries.messageId })
        .from(messageDeliveries)
        .where(eq(messageDeliveries.deviceId, d.id))
      expect(deliveries).toHaveLength(0)
    } finally {
      await db.delete(messageDeliveries).where(eq(messageDeliveries.deviceId, d.id))
      await db.delete(messages).where(eq(messages.id, msg.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(devices).where(eq(devices.id, d.id))
      await db.delete(users).where(eq(users.id, u.id))
    }
  })
})

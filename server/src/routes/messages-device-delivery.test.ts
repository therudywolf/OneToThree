import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, messageDeliveries, messages, users } from '../db/schema.js'

describe('messages device delivery contract', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('scopes pending + delivered ack to current device id', async () => {
    const u1Name = `md1${Date.now().toString(36)}`
    const u2Name = `md2${Date.now().toString(36)}`

    const [u1] = await db
      .insert(users)
      .values({
        username: u1Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const [u2] = await db
      .insert(users)
      .values({
        username: u2Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })

    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: u1.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: u2.id, encryptedGroupKey: null, role: 'member' },
    ])

    const [dA] = await db
      .insert(devices)
      .values({
        userId: u2.id,
        clientDeviceKey: `dA-${randomUUID()}`,
        deviceName: 'Recipient A',
        e2eePublicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: devices.id })

    const [dB] = await db
      .insert(devices)
      .values({
        userId: u2.id,
        clientDeviceKey: `dB-${randomUUID()}`,
        deviceName: 'Recipient B',
        e2eePublicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: devices.id })

    const senderToken = await app!.jwt.sign({ sub: u1.id, username: u1.username, jti: randomUUID() })
    const tokenA = await app!.jwt.sign({ sub: u2.id, username: u2.username, device_id: dA.id, jti: randomUUID() })
    const tokenB = await app!.jwt.sign({ sub: u2.id, username: u2.username, device_id: dB.id, jti: randomUUID() })

    const sent = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: chat.id,
        content: null,
        iv: null,
        ciphertexts: [
          { device_id: dA.id, ciphertext: 'ct-A', iv: 'iv-A' },
          { device_id: dB.id, ciphertext: 'ct-B', iv: 'iv-B' },
        ],
      })
      .expect(200)
    const messageId = sent.body?.message?.id as string
    expect(messageId).toBeTruthy()

    const pendingA = await request(app!.server)
      .get(`/api/messages/sync/pending?chat_id=${encodeURIComponent(chat.id)}`)
      .set('Cookie', `fm_session=${tokenA}`)
      .expect(200)
    expect((pendingA.body?.messages ?? []).length).toBe(1)
    expect(pendingA.body.messages[0].device_ciphertext).toBe('ct-A')
    expect(pendingA.body.messages[0].device_iv).toBe('iv-A')

    await request(app!.server)
      .post('/api/messages/delivered')
      .set('Cookie', `fm_session=${tokenA}`)
      .send({ message_ids: [messageId] })
      .expect(200)

    const [rowA] = await db
      .select({ deliveredAt: messageDeliveries.deliveredAt })
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.messageId, messageId), eq(messageDeliveries.deviceId, dA.id)))
      .limit(1)
    const [rowB] = await db
      .select({ deliveredAt: messageDeliveries.deliveredAt })
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.messageId, messageId), eq(messageDeliveries.deviceId, dB.id)))
      .limit(1)
    expect(rowA?.deliveredAt).not.toBeNull()
    expect(rowB?.deliveredAt ?? null).toBeNull()

    const pendingB = await request(app!.server)
      .get(`/api/messages/sync/pending?chat_id=${encodeURIComponent(chat.id)}`)
      .set('Cookie', `fm_session=${tokenB}`)
      .expect(200)
    expect((pendingB.body?.messages ?? []).length).toBe(1)
    expect(pendingB.body.messages[0].device_ciphertext).toBe('ct-B')

    await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, messageId))
    await db.delete(messages).where(and(eq(messages.chatId, chat.id), eq(messages.id, messageId)))
    await db.delete(devices).where(and(eq(devices.userId, u2.id), inArray(devices.id, [dA.id, dB.id])))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(inArray(users.id, [u1.id, u2.id]))
  })

  it('rejects direct_e2e send without fan-out slots', async () => {
    const u1Name = `mf1${Date.now().toString(36)}`
    const u2Name = `mf2${Date.now().toString(36)}`

    const [u1] = await db
      .insert(users)
      .values({
        username: u1Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const [u2] = await db
      .insert(users)
      .values({
        username: u2Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: u1.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: u2.id, encryptedGroupKey: null, role: 'member' },
    ])

    const senderToken = await app!.jwt.sign({ sub: u1.id, username: u1.username, jti: randomUUID() })

    await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: chat.id,
        content: 'legacy-cipher',
        iv: 'legacy-iv',
      })
      .expect(400)

    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(inArray(users.id, [u1.id, u2.id]))
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, messageDeliveries, messages, users } from '../db/schema.js'
import { DELETED_USER_ID, DELETED_USER_USERNAME } from './users.js'

describe('DELETE /me/account — tombstones, not gaps', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('re-points the deleted user\'s messages to the [deleted] sentinel and redacts them', async () => {
    const ecdh = () => JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() })
    const [a] = await db
      .insert(users)
      .values({ username: `del${Date.now().toString(36)}`, publicKeyJwk: ecdh() })
      .returning({ id: users.id, username: users.username })
    const [b] = await db
      .insert(users)
      .values({ username: `peer${Date.now().toString(36)}`, publicKeyJwk: ecdh() })
      .returning({ id: users.id, username: users.username })

    const [chat] = await db.insert(chats).values({ type: 'direct_e2e', name: null }).returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: a.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: b.id, encryptedGroupKey: null, role: 'member' },
    ])
    const [aDev] = await db
      .insert(devices)
      .values({ userId: a.id, clientDeviceKey: `a-${randomUUID()}`, deviceName: 'A' })
      .returning({ id: devices.id })
    const [bDev] = await db
      .insert(devices)
      .values({ userId: b.id, clientDeviceKey: `b-${randomUUID()}`, deviceName: 'B' })
      .returning({ id: devices.id })

    const aToken = await app!.jwt.sign({ sub: a.id, username: a.username, device_id: aDev.id, jti: randomUUID() })

    // A sends a DIRECT message — creates the row + per-device delivery slots.
    const sent = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${aToken}`)
      .send({
        chat_id: chat.id,
        protocol_version: 2,
        ciphertexts: [
          { device_id: aDev.id, ciphertext: 'self-slot', iv: 'dr:v2' },
          { device_id: bDev.id, ciphertext: 'peer-slot', iv: 'dr:v2' },
        ],
      })
      .expect(200)
    const msgId = sent.body?.message?.id as string
    expect(msgId).toBeTruthy()

    // A deletes their account.
    await request(app!.server)
      .delete('/api/users/me/account')
      .set('Cookie', `fm_session=${aToken}`)
      .send({ confirm_username: a.username })
      .expect(200)

    // The message SURVIVED, re-pointed to the sentinel and redacted.
    const [row] = await db
      .select({ senderId: messages.senderId, content: messages.content, iv: messages.iv })
      .from(messages)
      .where(eq(messages.id, msgId))
      .limit(1)
    expect(row).toBeTruthy()
    expect(row!.senderId).toBe(DELETED_USER_ID)
    expect(row!.content).toBe('[deleted]')
    expect(row!.iv).toBe('system:v1')

    // The DIRECT per-device ciphertext slots were dropped (can't decrypt back).
    const slots = await db
      .select({ id: messageDeliveries.messageId })
      .from(messageDeliveries)
      .where(eq(messageDeliveries.messageId, msgId))
    expect(slots.length).toBe(0)

    // The deleted user is gone; the sentinel exists.
    const [gone] = await db.select({ id: users.id }).from(users).where(eq(users.id, a.id)).limit(1)
    expect(gone).toBeFalsy()
    const [sentinel] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, DELETED_USER_ID))
      .limit(1)
    expect(sentinel?.username).toBe(DELETED_USER_USERNAME)

    // Cleanup (leave the shared sentinel row in place).
    await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, msgId))
    await db.delete(messages).where(eq(messages.chatId, chat.id))
    await db.delete(devices).where(inArray(devices.id, [bDev.id]))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(and(eq(users.id, b.id)))
  })
})

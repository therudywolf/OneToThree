import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { attachments, chatMembers, chats, devices, users } from '../db/schema.js'

describe('album attachment linking', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('links EVERY album attachment key to the message, not just item 1', async () => {
    const username = `alb${Date.now().toString(36)}`
    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const [dev] = await db
      .insert(devices)
      .values({ userId: u.id, clientDeviceKey: `d-${randomUUID()}`, deviceName: 'd', linkedAt: new Date() })
      .returning({ id: devices.id })
    const cookie = `fm_session=${await app!.jwt.sign({ sub: u.id, username: u.username, device_id: dev.id, jti: randomUUID() })}`

    const [chat] = await db
      .insert(chats)
      .values({ type: 'public_open', name: 'album-test' })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values({ chatId: chat.id, userId: u.id, encryptedGroupKey: null, role: 'owner' })

    // Three "uploaded" album objects, all orphan (message_id = null) for now.
    const keys = [0, 1, 2].map(() => `chats/${chat.id}/${u.id}/${randomUUID()}.bin`)
    await db.insert(attachments).values(
      keys.map((k) => ({
        chatId: chat.id,
        uploaderId: u.id,
        bucket: 'test-bucket',
        objectKey: k,
        contentType: 'application/octet-stream',
        sizeBytes: 10,
      }))
    )

    try {
      const res = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', cookie)
        .send({
          chat_id: chat.id,
          content: 'ct',
          iv: 'iv',
          media_path: keys[0],
          media_type: 'image',
          media_iv: 'miv',
          attachment_keys: [keys[1], keys[2]],
        })
        .expect(200)
      const messageId = res.body.message?.id as string
      expect(typeof messageId).toBe('string')

      // ALL three album objects must now point at the message — none left orphan.
      const rows = await db
        .select({ objectKey: attachments.objectKey, messageId: attachments.messageId })
        .from(attachments)
        .where(inArray(attachments.objectKey, keys))
      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.messageId === messageId)).toBe(true)

      // A key from another chat/user must be rejected (validation parity).
      await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', cookie)
        .send({
          chat_id: chat.id,
          content: 'ct',
          iv: 'iv',
          media_path: keys[0],
          media_type: 'image',
          media_iv: 'miv',
          attachment_keys: [`chats/${randomUUID()}/${randomUUID()}/x.bin`],
        })
        .expect(400)
    } finally {
      await db.delete(attachments).where(eq(attachments.chatId, chat.id))
      // messages cascade on chat delete
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(devices).where(eq(devices.userId, u.id))
      await db.delete(users).where(eq(users.id, u.id))
    }
  })
})

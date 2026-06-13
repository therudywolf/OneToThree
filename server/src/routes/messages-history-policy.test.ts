import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, messages, users } from '../db/schema.js'

// A freshly-linked device must not be handed the chat's pre-link history by the
// server. (The explicit per-device "unlock old history" route was removed; the
// future-only policy itself — messages.ts — stays and is what we assert here.)
describe('messages history sync policy', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('a new linked device sees only post-link history, never the chat backlog', async () => {
    const u1Name = `hp1${Date.now().toString(36)}`
    const u2Name = `hp2${Date.now().toString(36)}`
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

    const linkedAt = new Date()
    const [newDevice] = await db
      .insert(devices)
      .values({
        userId: u2.id,
        clientDeviceKey: `new-device-${randomUUID()}`,
        deviceName: 'New linked',
        linkedAt,
      })
      .returning({ id: devices.id })

    const oldDate = new Date(linkedAt.getTime() - 60_000)
    const newDate = new Date(linkedAt.getTime() + 60_000)
    const [oldMsg] = await db
      .insert(messages)
      .values({ chatId: chat.id, senderId: u1.id, content: 'old-message', iv: 'iv-old', createdAt: oldDate })
      .returning({ id: messages.id })
    const [futureMsg] = await db
      .insert(messages)
      .values({ chatId: chat.id, senderId: u1.id, content: 'future-message', iv: 'iv-new', createdAt: newDate })
      .returning({ id: messages.id })

    const token = await app!.jwt.sign({
      sub: u2.id,
      username: u2.username,
      device_id: newDevice.id,
      jti: randomUUID(),
    })
    const cookie = `fm_session=${token}`

    try {
      const limited = await request(app!.server)
        .get(`/api/messages/${chat.id}`)
        .set('Cookie', cookie)
        .expect(200)
      const limitedIds = (limited.body.messages ?? []).map((m: { id: string }) => m.id)
      expect(limitedIds).toContain(futureMsg.id)
      expect(limitedIds).not.toContain(oldMsg.id)
    } finally {
      await db.delete(messages).where(and(eq(messages.chatId, chat.id), inArray(messages.id, [oldMsg.id, futureMsg.id])))
      await db.delete(devices).where(eq(devices.userId, u2.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(inArray(users.id, [u1.id, u2.id]))
    }
  })
})

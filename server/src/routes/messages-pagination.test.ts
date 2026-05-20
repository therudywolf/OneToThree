import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'

describe('GET /messages/:chatId — keyset pagination', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('honours before/limit and keeps oldest -> newest order', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: `pg-${Date.now().toString(36)}`,
        publicKeyJwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
      })
      .returning({ id: users.id, username: users.username })
    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })
    await db
      .insert(chatMembers)
      .values({ chatId: chat.id, userId: user.id, encryptedGroupKey: null, role: 'owner' })

    const base = Date.now() - 10 * 60_000
    const times = [0, 1, 2, 3, 4].map((i) => new Date(base + i * 60_000))
    for (let i = 0; i < times.length; i++) {
      await db.insert(messages).values({
        chatId: chat.id,
        senderId: user.id,
        content: `m${i}`,
        iv: `iv${i}`,
        createdAt: times[i],
      })
    }

    const cookie = `fm_session=${await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      jti: randomUUID(),
    })}`

    try {
      // limit only — oldest-first slice.
      const first = await request(app!.server)
        .get(`/api/messages/${chat.id}?limit=2`)
        .set('Cookie', cookie)
        .expect(200)
      expect(first.body.messages.map((m: { content: string }) => m.content)).toEqual([
        'm0',
        'm1',
      ])

      // before=times[3] -> messages strictly older, newest 2 of them, asc order.
      const older = await request(app!.server)
        .get(
          `/api/messages/${chat.id}?limit=2&before=${encodeURIComponent(
            times[3].toISOString()
          )}`
        )
        .set('Cookie', cookie)
        .expect(200)
      expect(older.body.messages.map((m: { content: string }) => m.content)).toEqual([
        'm1',
        'm2',
      ])

      // Invalid before -> 400.
      await request(app!.server)
        .get(`/api/messages/${chat.id}?before=not-a-date`)
        .set('Cookie', cookie)
        .expect(400)
    } finally {
      await db.delete(messages).where(eq(messages.chatId, chat.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})

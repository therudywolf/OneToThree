import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'

describe('messages flow routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('sends and fetches direct message between members', async () => {
    const u1Name = `m1${Date.now().toString(36)}`
    const u2Name = `m2${Date.now().toString(36)}`
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

    const u1Token = await app!.jwt.sign({ sub: u1.id, username: u1.username, jti: randomUUID() })
    const u2Token = await app!.jwt.sign({ sub: u2.id, username: u2.username, jti: randomUUID() })

    const sent = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${u1Token}`)
      .send({
        chat_id: chat.id,
        content: 'hello-stage-flow',
        iv: 'iv-test',
      })
      .expect(200)

    expect(sent.body?.message?.id).toBeTruthy()
    const messageId = sent.body.message.id as string

    const listForPeer = await request(app!.server)
      .get(`/api/messages/${chat.id}`)
      .set('Cookie', `fm_session=${u2Token}`)
      .expect(200)

    const rows = listForPeer.body?.messages ?? []
    const row = rows.find((m: { id: string }) => m.id === messageId)
    expect(row?.content).toBe('hello-stage-flow')
    expect(row?.sender_id).toBe(u1.id)

    const search = await request(app!.server)
      .get('/api/messages/search')
      .set('Cookie', `fm_session=${u2Token}`)
      .query({ chatId: chat.id, q: 'stage-flow' })
      .expect(200)
    expect((search.body?.messages ?? []).some((m: { id: string }) => m.id === messageId)).toBe(true)

    await db.delete(messages).where(and(eq(messages.chatId, chat.id), inArray(messages.senderId, [u1.id, u2.id])))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(inArray(users.id, [u1.id, u2.id]))
  })
})

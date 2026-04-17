import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, users } from '../db/schema.js'

describe('chat favorites routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('marks and unmarks chat as favorite for sidebar ordering', async () => {
    const username = `fav${Date.now().toString(36)}`
    const [u] = await db
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
    expect(u).toBeTruthy()

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: 'Fav test chat' })
      .returning({ id: chats.id })
    expect(chat).toBeTruthy()

    await db.insert(chatMembers).values({
      chatId: chat.id,
      userId: u.id,
      encryptedGroupKey: null,
      role: 'owner',
    })

    const token = await app!.jwt.sign({
      sub: u.id,
      username: u.username,
      jti: randomUUID(),
    })
    const cookie = `fm_session=${token}`

    await request(app!.server)
      .post(`/api/chats/${chat.id}/favorite`)
      .set('Cookie', cookie)
      .expect(200)

    const list = await request(app!.server)
      .get('/api/chats')
      .set('Cookie', cookie)
      .expect(200)
    const row = (list.body?.chats ?? []).find((c: { id: string }) => c.id === chat.id)
    expect(row?.is_favorite).toBe(true)

    const favorites = await request(app!.server)
      .get('/api/chats/favorites')
      .set('Cookie', cookie)
      .expect(200)
    expect((favorites.body?.chats ?? []).some((c: { id: string }) => c.id === chat.id)).toBe(true)

    await request(app!.server)
      .delete(`/api/chats/${chat.id}/favorite`)
      .set('Cookie', cookie)
      .expect(200)

    const listAfter = await request(app!.server)
      .get('/api/chats')
      .set('Cookie', cookie)
      .expect(200)
    const rowAfter = (listAfter.body?.chats ?? []).find((c: { id: string }) => c.id === chat.id)
    expect(rowAfter?.is_favorite).toBe(false)

    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(and(eq(users.id, u.id), eq(users.username, u.username)))
  })
})

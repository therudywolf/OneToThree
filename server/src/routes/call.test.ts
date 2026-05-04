import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, users } from '../db/schema.js'

async function createUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('call token route', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true
  const livekitPrev = {
    API_KEY: process.env.LIVEKIT_API_KEY,
    API_SECRET: process.env.LIVEKIT_API_SECRET,
    URL: process.env.LIVEKIT_URL,
    CALL_MEDIA_MODE: process.env.CALL_MEDIA_MODE,
  }

  beforeAll(async () => {
    process.env.CALL_MEDIA_MODE = 'self_hosted'
    process.env.LIVEKIT_API_KEY = 'test-livekit-api-key'
    process.env.LIVEKIT_API_SECRET = 'test-livekit-secret-must-be-32-chars'
    process.env.LIVEKIT_URL = 'wss://livekit.example.test'
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterAll(async () => {
    if (app) await app.close()
    process.env.LIVEKIT_API_KEY = livekitPrev.API_KEY
    process.env.LIVEKIT_API_SECRET = livekitPrev.API_SECRET
    process.env.LIVEKIT_URL = livekitPrev.URL
    process.env.CALL_MEDIA_MODE = livekitPrev.CALL_MEDIA_MODE
  })

  it('authorizes only chat members and canonicalizes authorized room ids', async () => {
    if (!dbAvailable) return
    const member = await createUser(`call-member-${Date.now().toString(36)}`)
    const outsider = await createUser(`call-outsider-${Date.now().toString(36)}`)
    const [chat] = await db
      .insert(chats)
      .values({ type: 'group_e2e', name: null })
      .returning({ id: chats.id })
    const memberToken = await app!.jwt.sign({ sub: member.id, username: member.username, jti: randomUUID() })
    const outsiderToken = await app!.jwt.sign({ sub: outsider.id, username: outsider.username, jti: randomUUID() })

    await db.insert(chatMembers).values({
      chatId: chat.id,
      userId: member.id,
      encryptedGroupKey: null,
      role: 'owner',
    })

    try {
      const ok = await request(app!.server)
        .post('/api/call/token')
        .set('Cookie', `fm_session=${memberToken}`)
        .send({ room: `call:${chat.id}` })
        .expect(200)

      expect(ok.body.room).toBe(chat.id)
      expect(ok.body.url).toBe('wss://livekit.example.test')
      expect(typeof ok.body.call_e2ee_key).toBe('string')

      const payload = decodeJwtPayload(ok.body.token as string)
      expect(payload.sub).toBe(member.id)
      expect((payload.video as { room?: string }).room).toBe(chat.id)

      const denied = await request(app!.server)
        .post('/api/call/token')
        .set('Cookie', `fm_session=${outsiderToken}`)
        .send({ room: chat.id })
        .expect(403)
      expect(denied.body.error).toBe('NOT_A_MEMBER')

      const badRoom = await request(app!.server)
        .post('/api/call/token')
        .set('Cookie', `fm_session=${memberToken}`)
        .send({ room: 'call:not-a-uuid' })
        .expect(400)
      expect(badRoom.body.error).toBe('ROOM_NOT_AUTHORIZABLE')
    } finally {
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(eq(users.id, member.id))
      await db.delete(users).where(eq(users.id, outsider.id))
    }
  })
})

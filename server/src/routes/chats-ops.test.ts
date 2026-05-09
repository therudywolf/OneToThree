import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { inArray, eq } from 'drizzle-orm'
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

describe('chat create/update/member routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('creates a group, updates a member role, then removes that member', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`ops-owner-${stamp}`)
    const member = await createUser(`ops-member-${stamp}`)
    const cookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', cookie)
        .send({
          type: 'group_e2e',
          name: 'Ops group',
          members: [
            { userId: owner.id, encryptedGroupKey: 'owner-key' },
            { userId: member.id, encryptedGroupKey: 'member-key' },
          ],
        })
        .expect(201)
      chatId = created.body.chat.id
      expect(created.body.chat.member_ids).toContain(member.id)

      await request(app!.server)
        .patch(`/api/chats/${chatId}/members/${member.id}/role`)
        .set('Cookie', cookie)
        .send({ role: 'admin' })
        .expect(200)

      const [roleRow] = await db
        .select({ role: chatMembers.role })
        .from(chatMembers)
        .where(eq(chatMembers.userId, member.id))
        .limit(1)
      expect(roleRow?.role).toBe('admin')

      await request(app!.server)
        .delete(`/api/chats/${chatId}/members/${member.id}`)
        .set('Cookie', cookie)
        .expect(200)

      const detail = await request(app!.server)
        .get(`/api/chats/${chatId}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(detail.body.members.some((m: { user_id: string }) => m.user_id === member.id)).toBe(false)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })
})

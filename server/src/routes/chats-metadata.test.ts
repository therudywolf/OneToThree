import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
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

describe('PATCH /chats/:chatId — title, description, publicity', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function cookieFor(u: { id: string; username: string }) {
    return `fm_session=${await app!.jwt.sign({ sub: u.id, username: u.username, jti: randomUUID() })}`
  }

  it('owner edits metadata; members cannot; unlisting removes the chat from discovery', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`meta-owner-${stamp}`)
    const member = await createUser(`meta-member-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const memberCookie = await cookieFor(member)
    const originalName = `Meta channel ${stamp}`

    let chatId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: originalName, member_ids: [owner.id, member.id] })
        .expect(201)
      chatId = created.body.chat.id as string

      // A fresh channel is listed by default — the column must not change
      // existing catalog behaviour.
      const before = await request(app!.server)
        .get(`/api/chats/discover?q=${encodeURIComponent(originalName)}`)
        .set('Cookie', memberCookie)
        .expect(200)
      expect(before.body.some((r: { id: string }) => r.id === chatId)).toBe(true)

      // Non-owner is refused.
      const forbidden = await request(app!.server)
        .patch(`/api/chats/${chatId}`)
        .set('Cookie', memberCookie)
        .send({ name: 'Hijacked' })
        .expect(403)
      expect(forbidden.body.error).toBe('FORBIDDEN')

      // Empty patch is rejected rather than treated as a no-op success.
      await request(app!.server)
        .patch(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .send({})
        .expect(400)

      // Owner renames and describes in one call.
      const renamed = `${originalName} renamed`
      const patched = await request(app!.server)
        .patch(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .send({ name: renamed, description: '  About this room  ' })
        .expect(200)
      expect(patched.body.name).toBe(renamed)
      // Description is trimmed on the way in.
      expect(patched.body.description).toBe('About this room')
      expect(patched.body.is_public).toBe(true)

      // Detail carries the new fields.
      const detail = await request(app!.server)
        .get(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(detail.body.chat.name).toBe(renamed)
      expect(detail.body.chat.description).toBe('About this room')
      expect(detail.body.chat.is_public).toBe(true)

      // Blank description clears it instead of storing whitespace.
      const cleared = await request(app!.server)
        .patch(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .send({ description: '   ' })
        .expect(200)
      expect(cleared.body.description).toBeNull()

      // Unlisting hides it from discovery…
      await request(app!.server)
        .patch(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .send({ is_public: false })
        .expect(200)
      const after = await request(app!.server)
        .get(`/api/chats/discover?q=${encodeURIComponent(renamed)}`)
        .set('Cookie', memberCookie)
        .expect(200)
      expect(after.body.some((r: { id: string }) => r.id === chatId)).toBe(false)

      // …while the room itself stays perfectly reachable for its members.
      await request(app!.server)
        .get(`/api/chats/${chatId}`)
        .set('Cookie', memberCookie)
        .expect(200)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  it('rejects metadata edits on a direct chat and avatar presign from a non-owner', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`meta-d-owner-${stamp}`)
    const member = await createUser(`meta-d-member-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const memberCookie = await cookieFor(member)

    let directId: string | null = null
    let channelId: string | null = null
    try {
      const [directRow] = await db
        .insert(chats)
        .values({ type: 'direct_e2e', name: null })
        .returning({ id: chats.id })
      directId = directRow.id
      await db.insert(chatMembers).values([
        { chatId: directId, userId: owner.id, role: 'owner' },
        { chatId: directId, userId: member.id, role: 'member' },
      ])

      const notGroup = await request(app!.server)
        .patch(`/api/chats/${directId}`)
        .set('Cookie', ownerCookie)
        .send({ name: 'nope' })
        .expect(400)
      expect(notGroup.body.error).toBe('NOT_GROUP_CHAT')

      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: `Avatar gate ${stamp}`, member_ids: [owner.id, member.id] })
        .expect(201)
      channelId = created.body.chat.id as string

      const denied = await request(app!.server)
        .post(`/api/chats/${channelId}/avatar/presign`)
        .set('Cookie', memberCookie)
        .send({})
        .expect(403)
      expect(denied.body.error).toBe('FORBIDDEN')

      // Commit without a matching presign must not accept a caller-chosen key.
      const forged = await request(app!.server)
        .post(`/api/chats/${channelId}/avatar/commit`)
        .set('Cookie', ownerCookie)
        .send({ avatar_key: `avatars/${owner.id}/${randomUUID()}.jpg` })
        .expect(400)
      expect(forged.body.error).toBe('NO_PENDING_AVATAR')
    } finally {
      for (const id of [directId, channelId]) {
        if (!id) continue
        await db.delete(chatMembers).where(eq(chatMembers.chatId, id))
        await db.delete(chats).where(eq(chats.id, id))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'

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

describe('channel routes: posting gate, channel-role, discussion link', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function cookieFor(user: { id: string; username: string }): Promise<string> {
    return `fm_session=${await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })}`
  }

  async function deleteChat(chatId: string) {
    await db.delete(messages).where(eq(messages.chatId, chatId))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
  }

  it('creator owns the feed; subscribers cannot post until promoted to editor', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`chn-owner-${stamp}`)
    const member = await createUser(`chn-member-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const memberCookie = await cookieFor(member)

    let chatId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: 'Broadcast test', member_ids: [owner.id, member.id] })
        .expect(201)
      chatId = created.body.chat.id as string

      // Detail exposes per-member channel_role: creator=owner, invitee=subscriber.
      const detail = await request(app!.server)
        .get(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      const roleById = new Map(
        (detail.body.members as Array<{ user_id: string; channel_role: string | null }>).map(
          (m) => [m.user_id, m.channel_role]
        )
      )
      expect(roleById.get(owner.id)).toBe('owner')
      expect(roleById.get(member.id)).toBe('subscriber')
      expect(detail.body.chat.discussion_chat_id).toBeNull()

      const denied = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', memberCookie)
        .send({ chat_id: chatId, content: Buffer.from('hi').toString('base64'), iv: 'public' })
        .expect(403)
      expect(denied.body.error).toBe('CHANNEL_SUBSCRIBERS_CANNOT_POST')

      await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', ownerCookie)
        .send({ chat_id: chatId, content: Buffer.from('hello subscribers').toString('base64'), iv: 'public' })
        .expect(200)

      await request(app!.server)
        .patch(`/api/chats/${chatId}/members/${member.id}/channel-role`)
        .set('Cookie', ownerCookie)
        .send({ channel_role: 'editor' })
        .expect(200)

      await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', memberCookie)
        .send({ chat_id: chatId, content: Buffer.from('editor now').toString('base64'), iv: 'public' })
        .expect(200)
    } finally {
      if (chatId) await deleteChat(chatId)
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  it('channel-role PATCH: owner-only, no self-patch, subscriber/editor only, channels only', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`chr-owner-${stamp}`)
    const member = await createUser(`chr-member-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const memberCookie = await cookieFor(member)

    let channelId: string | null = null
    let groupId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: 'Role rules', member_ids: [owner.id, member.id] })
        .expect(201)
      channelId = created.body.chat.id as string

      // Actor below owner is refused outright.
      const forbidden = await request(app!.server)
        .patch(`/api/chats/${channelId}/members/${owner.id}/channel-role`)
        .set('Cookie', memberCookie)
        .send({ channel_role: 'editor' })
        .expect(403)
      expect(forbidden.body.error).toBe('FORBIDDEN')

      // The owner cannot demote their own feed role.
      const self = await request(app!.server)
        .patch(`/api/chats/${channelId}/members/${owner.id}/channel-role`)
        .set('Cookie', ownerCookie)
        .send({ channel_role: 'editor' })
        .expect(400)
      expect(self.body.error).toBe('CANNOT_PATCH_SELF')

      // 'owner' moves only with the ownership transfer in PATCH .../role.
      const ownerValue = await request(app!.server)
        .patch(`/api/chats/${channelId}/members/${member.id}/channel-role`)
        .set('Cookie', ownerCookie)
        .send({ channel_role: 'owner' })
        .expect(400)
      expect(ownerValue.body.error).toBe('INVALID_BODY')

      // Unknown target is not a member.
      const ghost = await request(app!.server)
        .patch(`/api/chats/${channelId}/members/${randomUUID()}/channel-role`)
        .set('Cookie', ownerCookie)
        .send({ channel_role: 'editor' })
        .expect(404)
      expect(ghost.body.error).toBe('NOT_A_MEMBER')

      // Non-channel chats have no feed roles at all.
      const [groupRow] = await db
        .insert(chats)
        .values({ type: 'group_e2e', name: 'Not a channel' })
        .returning({ id: chats.id })
      groupId = groupRow.id
      await db.insert(chatMembers).values([
        { chatId: groupId, userId: owner.id, role: 'owner', encryptedGroupKey: 'k-owner' },
        { chatId: groupId, userId: member.id, role: 'member', encryptedGroupKey: 'k-member' },
      ])
      const notChannel = await request(app!.server)
        .patch(`/api/chats/${groupId}/members/${member.id}/channel-role`)
        .set('Cookie', ownerCookie)
        .send({ channel_role: 'editor' })
        .expect(400)
      expect(notChannel.body.error).toBe('NOT_CHANNEL_CHAT')
    } finally {
      if (channelId) await deleteChat(channelId)
      if (groupId) await deleteChat(groupId)
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  it('discussion PATCH: owner-only, group-typed member target, clearable', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`dsc-owner-${stamp}`)
    const member = await createUser(`dsc-member-${stamp}`)
    const outsider = await createUser(`dsc-outsider-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const memberCookie = await cookieFor(member)

    let channelId: string | null = null
    let otherChannelId: string | null = null
    let discussionId: string | null = null
    let foreignGroupId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: 'With comments', member_ids: [owner.id, member.id] })
        .expect(201)
      channelId = created.body.chat.id as string

      const otherChannel = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: 'Second channel', member_ids: [owner.id] })
        .expect(201)
      otherChannelId = otherChannel.body.chat.id as string

      const [discussionRow] = await db
        .insert(chats)
        .values({ type: 'public_open', name: 'Comments room' })
        .returning({ id: chats.id })
      discussionId = discussionRow.id
      await db
        .insert(chatMembers)
        .values({ chatId: discussionId, userId: owner.id, role: 'owner' })

      const [foreignRow] = await db
        .insert(chats)
        .values({ type: 'public_open', name: 'Someone else room' })
        .returning({ id: chats.id })
      foreignGroupId = foreignRow.id
      await db
        .insert(chatMembers)
        .values({ chatId: foreignGroupId, userId: outsider.id, role: 'owner' })

      // Subscribers cannot rewire the channel.
      const forbidden = await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', memberCookie)
        .send({ discussion_chat_id: discussionId })
        .expect(403)
      expect(forbidden.body.error).toBe('FORBIDDEN')

      // Self-link is refused before any target lookup.
      const selfLink = await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', ownerCookie)
        .send({ discussion_chat_id: channelId })
        .expect(400)
      expect(selfLink.body.error).toBe('DISCUSSION_SELF')

      // A channel cannot serve as another channel's discussion room.
      const wrongType = await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', ownerCookie)
        .send({ discussion_chat_id: otherChannelId })
        .expect(400)
      expect(wrongType.body.error).toBe('DISCUSSION_NOT_GROUP')

      // The owner must be a member of the target room.
      const foreign = await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', ownerCookie)
        .send({ discussion_chat_id: foreignGroupId })
        .expect(403)
      expect(foreign.body.error).toBe('DISCUSSION_NOT_MEMBER')

      // Valid link lands in the detail payload…
      await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', ownerCookie)
        .send({ discussion_chat_id: discussionId })
        .expect(200)
      const linked = await request(app!.server)
        .get(`/api/chats/${channelId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(linked.body.chat.discussion_chat_id).toBe(discussionId)

      // …and null clears it.
      await request(app!.server)
        .patch(`/api/chats/${channelId}/discussion`)
        .set('Cookie', ownerCookie)
        .send({ discussion_chat_id: null })
        .expect(200)
      const cleared = await request(app!.server)
        .get(`/api/chats/${channelId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(cleared.body.chat.discussion_chat_id).toBeNull()
    } finally {
      if (channelId) await deleteChat(channelId)
      if (otherChannelId) await deleteChat(otherChannelId)
      if (discussionId) await deleteChat(discussionId)
      if (foreignGroupId) await deleteChat(foreignGroupId)
      await db.delete(users).where(inArray(users.id, [owner.id, member.id, outsider.id]))
    }
  })
})

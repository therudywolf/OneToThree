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

describe('profile-pinned personal channel (users.profile_channel_id)', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('links an owned channel, serves it on the profile, validates foreign/wrong-type, unlinks', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`pc-owner-${stamp}`)
    const viewer = await createUser(`pc-viewer-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`
    const viewerCookie = `fm_session=${await app!.jwt.sign({ sub: viewer.id, username: viewer.username, jti: randomUUID() })}`

    let channelId: string | null = null
    let groupId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'channel', name: 'My wall', member_ids: [owner.id] })
        .expect(201)
      channelId = created.body.chat.id as string

      // Discoverable so a stranger's profile view resolves at all.
      await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', ownerCookie)
        .send({ is_discoverable: true })
        .expect(200)

      // A stranger cannot pin somebody else's channel.
      const foreign = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', viewerCookie)
        .send({ profile_channel_id: channelId })
        .expect(403)
      expect(foreign.body.error).toBe('NOT_CHANNEL_OWNER')

      // Only channel-typed chats qualify.
      const [groupRow] = await db
        .insert(chats)
        .values({ type: 'group_e2e', name: 'Not a channel' })
        .returning({ id: chats.id })
      groupId = groupRow.id
      await db
        .insert(chatMembers)
        .values({ chatId: groupId, userId: owner.id, role: 'owner', encryptedGroupKey: 'k' })
      const wrongType = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', ownerCookie)
        .send({ profile_channel_id: groupId })
        .expect(400)
      expect(wrongType.body.error).toBe('NOT_CHANNEL_CHAT')

      // The owner links their channel; the PATCH echoes it back.
      const linked = await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', ownerCookie)
        .send({ profile_channel_id: channelId })
        .expect(200)
      expect(linked.body.profile_channel_id).toBe(channelId)

      // /me/settings carries it for the settings UI.
      const settings = await request(app!.server)
        .get('/api/users/me/settings')
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(settings.body.profile_channel_id).toBe(channelId)

      // A viewer sees the channel card payload with a join handle.
      const profile = await request(app!.server)
        .get(`/api/users/${owner.username}/profile`)
        .set('Cookie', viewerCookie)
        .expect(200)
      expect(profile.body.profile_channel).toMatchObject({
        id: channelId,
        name: 'My wall',
        member_count: 1,
      })
      expect(
        profile.body.profile_channel.invite_slug || profile.body.profile_channel.invite_code
      ).toBeTruthy()

      // Unlink with null.
      await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', ownerCookie)
        .send({ profile_channel_id: null })
        .expect(200)
      const cleared = await request(app!.server)
        .get(`/api/users/${owner.username}/profile`)
        .set('Cookie', viewerCookie)
        .expect(200)
      expect(cleared.body.profile_channel).toBeNull()

      // Deleting the channel auto-unlinks via ON DELETE SET NULL.
      await request(app!.server)
        .patch('/api/users/me')
        .set('Cookie', ownerCookie)
        .send({ profile_channel_id: channelId })
        .expect(200)
      await db.delete(chatMembers).where(eq(chatMembers.chatId, channelId))
      await db.delete(chats).where(eq(chats.id, channelId))
      channelId = null
      const [ownerRow] = await db
        .select({ profileChannelId: users.profileChannelId })
        .from(users)
        .where(eq(users.id, owner.id))
        .limit(1)
      expect(ownerRow?.profileChannelId).toBeNull()
    } finally {
      for (const chatId of [channelId, groupId]) {
        if (!chatId) continue
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, viewer.id]))
    }
  })
})

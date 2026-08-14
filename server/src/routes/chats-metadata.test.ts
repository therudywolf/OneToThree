import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'

// S3/MinIO is mocked so this runs anywhere (the predeploy gate has no MinIO).
// Presigning is a local HMAC op, but ensureBucketExists() would hit MinIO — the
// avatar authorization under test is pure DB.
vi.mock('../lib/s3.js', () => ({
  createS3Client: () => ({}),
  createS3ClientForPresigning: () => ({}),
  deleteObjectIfExists: async () => undefined,
  ensureBucketExists: async () => undefined,
  getAvatarsBucketName: () => 'avatars',
  getBucketName: () => 'test-bucket',
  presignGetObject: async () => 'https://minio.test/get?sig=x',
  presignPutObject: async () => 'https://minio.test/put?sig=x',
  rewritePresignedUrlToPublicBase: (u: string) => u,
}))

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

  it('chat avatar url: a private group hides behind membership, a listed room does not', async () => {
    // `is_public` is a column on EVERY chat with NOT NULL DEFAULT true, and the
    // client hides the publicity toggle for a private E2E group (the switch
    // would be a lie there — such a room is never listed). So gating this route
    // on `is_public` alone protected nothing for exactly the chats the docblock
    // promised to protect: any logged-in stranger who knew the uuid got a
    // 1-hour presigned GET for a private group's picture, in the same second
    // GET /chats/:chatId answered 403 for them.
    const stamp = Date.now().toString(36)
    const owner = await createUser(`meta-av-owner-${stamp}`)
    const stranger = await createUser(`meta-av-out-${stamp}`)
    const ownerCookie = await cookieFor(owner)
    const strangerCookie = await cookieFor(stranger)
    const avatarKey = () => `avatars/${randomUUID()}/${randomUUID()}.jpg`

    let groupId: string | null = null
    let listedId: string | null = null
    try {
      const [group] = await db
        .insert(chats)
        .values({ type: 'group_e2e', name: `Private group ${stamp}`, avatarKey: avatarKey() })
        .returning({ id: chats.id, isPublic: chats.isPublic })
      groupId = group.id
      await db.insert(chatMembers).values({ chatId: groupId, userId: owner.id, role: 'owner' })
      // The premise of the bug: nobody ever set this, it defaulted on.
      expect(group.isPublic).toBe(true)

      const denied = await request(app!.server)
        .get(`/api/storage/chat-avatar-url?chatId=${groupId}`)
        .set('Cookie', strangerCookie)
        .expect(404)
      expect(denied.body.error).toBe('NO_AVATAR')

      // …and the member it belongs to still gets the picture.
      const allowed = await request(app!.server)
        .get(`/api/storage/chat-avatar-url?chatId=${groupId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(allowed.body.downloadUrl).toContain('minio.test')

      // A room the catalog actually lists renders for strangers by design.
      const [listed] = await db
        .insert(chats)
        .values({ type: 'public_open', name: `Listed room ${stamp}`, avatarKey: avatarKey() })
        .returning({ id: chats.id })
      listedId = listed.id
      const shown = await request(app!.server)
        .get(`/api/storage/chat-avatar-url?chatId=${listedId}`)
        .set('Cookie', strangerCookie)
        .expect(200)
      expect(shown.body.downloadUrl).toContain('minio.test')

      // Unlist it and the same stranger falls back to the membership check.
      await db.update(chats).set({ isPublic: false }).where(eq(chats.id, listedId))
      await request(app!.server)
        .get(`/api/storage/chat-avatar-url?chatId=${listedId}`)
        .set('Cookie', strangerCookie)
        .expect(404)
    } finally {
      for (const id of [groupId, listedId]) {
        if (!id) continue
        await db.delete(chatMembers).where(eq(chatMembers.chatId, id))
        await db.delete(chats).where(eq(chats.id, id))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, stranger.id]))
    }
  })
})

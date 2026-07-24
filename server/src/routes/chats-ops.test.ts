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

  async function readKeyEpoch(chatId: string): Promise<number> {
    const [row] = await db
      .select({ keyEpoch: chats.keyEpoch })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)
    return row?.keyEpoch ?? -1
  }

  async function createGroup(
    app: FastifyInstance,
    ownerCookie: string,
    owner: { id: string },
    members: { id: string }[]
  ): Promise<string> {
    const created = await request(app.server)
      .post('/api/chats')
      .set('Cookie', ownerCookie)
      .send({
        type: 'group_e2e',
        name: 'Rekey group',
        members: [
          { userId: owner.id, encryptedGroupKey: 'owner-key' },
          ...members.map((m) => ({ userId: m.id, encryptedGroupKey: 'member-key' })),
        ],
      })
      .expect(201)
    return created.body.chat.id
  }

  // A departing member must trigger group-key rotation (epoch bump) so they can
  // no longer decrypt future traffic — for both kick and voluntary leave.
  it('bumps the key epoch when a member is kicked from a group_e2e chat', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`rk-kick-owner-${stamp}`)
    const member = await createUser(`rk-kick-member-${stamp}`)
    const cookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      chatId = await createGroup(app!, cookie, owner, [member])
      const before = await readKeyEpoch(chatId)

      await request(app!.server)
        .delete(`/api/chats/${chatId}/members/${member.id}`)
        .set('Cookie', cookie)
        .expect(200)

      expect(await readKeyEpoch(chatId)).toBe(before + 1)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  // #32 backward secrecy: a member JOINING a group_e2e chat must also bump the
  // key epoch, so the owner's rekey stamps a fresh epoch and the joiner receives
  // only the post-join key — never a pre-join epoch it could read history with.
  it('bumps the key epoch when a member joins a group_e2e chat via invite', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`rk-join-owner-${stamp}`)
    const seed = await createUser(`rk-join-seed-${stamp}`) // group_e2e needs ≥2 members
    const joiner = await createUser(`rk-join-joiner-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`
    const joinerCookie = `fm_session=${await app!.jwt.sign({ sub: joiner.id, username: joiner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      chatId = await createGroup(app!, ownerCookie, owner, [seed])
      const before = await readKeyEpoch(chatId)

      // Mint an invite code for the group and join through it.
      const code = `join-${stamp}-${randomUUID().slice(0, 8)}`
      await db.update(chats).set({ inviteCode: code }).where(eq(chats.id, chatId))

      await request(app!.server)
        .post(`/api/chats/join/${code}`)
        .set('Cookie', joinerCookie)
        .expect(200)

      // Joiner is now a member AND the epoch advanced by exactly one.
      const detail = await request(app!.server)
        .get(`/api/chats/${chatId}`)
        .set('Cookie', ownerCookie)
        .expect(200)
      expect(detail.body.members.some((m: { user_id: string }) => m.user_id === joiner.id)).toBe(true)
      expect(await readKeyEpoch(chatId)).toBe(before + 1)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, seed.id, joiner.id]))
    }
  })

  // A public_open join must NOT bump the epoch — it has no SECTOR key to rotate.
  it('does NOT bump the key epoch when a member joins a public_open chat', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`pj-owner-${stamp}`)
    const joiner = await createUser(`pj-joiner-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`
    const joinerCookie = `fm_session=${await app!.jwt.sign({ sub: joiner.id, username: joiner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({ type: 'public_open', name: 'Public room', member_ids: [owner.id] })
        .expect(201)
      chatId = created.body.chat.id
      const code = `pubjoin-${stamp}-${randomUUID().slice(0, 8)}`
      await db.update(chats).set({ inviteCode: code }).where(eq(chats.id, chatId!))
      const before = await readKeyEpoch(chatId!)

      await request(app!.server)
        .post(`/api/chats/join/${code}`)
        .set('Cookie', joinerCookie)
        .expect(200)

      expect(await readKeyEpoch(chatId!)).toBe(before)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, joiner.id]))
    }
  })

  it('bumps the key epoch when a non-owner voluntarily leaves a group_e2e chat', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`rk-leave-owner-${stamp}`)
    const member = await createUser(`rk-leave-member-${stamp}`)
    const memberCookie = `fm_session=${await app!.jwt.sign({ sub: member.id, username: member.username, jti: randomUUID() })}`
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      chatId = await createGroup(app!, ownerCookie, owner, [member])
      const before = await readKeyEpoch(chatId)

      await request(app!.server)
        .post(`/api/chats/${chatId}/leave`)
        .set('Cookie', memberCookie)
        .expect(200)

      // The owner remains, so the chat survives and its key epoch advances.
      expect(await readKeyEpoch(chatId)).toBe(before + 1)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  it('bumps the key epoch when the owner leaves and ownership transfers', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`rk-xfer-owner-${stamp}`)
    const member = await createUser(`rk-xfer-member-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      chatId = await createGroup(app!, ownerCookie, owner, [member])
      const before = await readKeyEpoch(chatId)

      await request(app!.server)
        .post(`/api/chats/${chatId}/leave`)
        .set('Cookie', ownerCookie)
        .expect(200)

      // Ownership transfers to the remaining member; the key epoch still advances.
      expect(await readKeyEpoch(chatId)).toBe(before + 1)
      const [survivor] = await db
        .select({ role: chatMembers.role })
        .from(chatMembers)
        .where(eq(chatMembers.userId, member.id))
        .limit(1)
      expect(survivor?.role).toBe('owner')
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })

  // Guards the ownership-transfer invariant the leave handler must preserve even
  // under concurrent departures: after the owner leaves a multi-member group,
  // EXACTLY ONE owner remains (never zero — an ownerless chat is unmanageable)
  // and the key epoch advances. The transfer + delete + epoch bump run in one txn.
  it('leaves exactly one owner (never zero) when the owner leaves a multi-member group', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`rk-multi-owner-${stamp}`)
    const m1 = await createUser(`rk-multi-m1-${stamp}`)
    const m2 = await createUser(`rk-multi-m2-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      chatId = await createGroup(app!, ownerCookie, owner, [m1, m2])
      const before = await readKeyEpoch(chatId)

      await request(app!.server)
        .post(`/api/chats/${chatId}/leave`)
        .set('Cookie', ownerCookie)
        .expect(200)

      const survivors = await db
        .select({ userId: chatMembers.userId, role: chatMembers.role })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
      expect(survivors).toHaveLength(2)
      expect(survivors.filter((s) => s.role === 'owner')).toHaveLength(1)
      expect(await readKeyEpoch(chatId)).toBe(before + 1)
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, m1.id, m2.id]))
    }
  })

  // Channels authorize posting by the SEPARATE channel_role column, so an
  // ownership transfer that only moved `role` left the new owner a 'subscriber'
  // (CHANNEL_SUBSCRIBERS_CANNOT_POST) while the demoted owner kept channel
  // 'owner'. The PATCH role=owner path must move channel_role too.
  it('channel ownership transfer moves channel_role with it', async () => {
    const stamp = Date.now().toString(36)
    const owner = await createUser(`ch-xfer-owner-${stamp}`)
    const member = await createUser(`ch-xfer-member-${stamp}`)
    const ownerCookie = `fm_session=${await app!.jwt.sign({ sub: owner.id, username: owner.username, jti: randomUUID() })}`

    let chatId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/chats')
        .set('Cookie', ownerCookie)
        .send({
          type: 'channel',
          name: 'Xfer channel',
          member_ids: [owner.id, member.id],
        })
        .expect(201)
      chatId = created.body.chat.id as string

      await request(app!.server)
        .patch(`/api/chats/${chatId}/members/${member.id}/role`)
        .set('Cookie', ownerCookie)
        .send({ role: 'owner' })
        .expect(200)

      const rows = await db
        .select({
          userId: chatMembers.userId,
          role: chatMembers.role,
          channelRole: chatMembers.channelRole,
        })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
      const newOwner = rows.find((r) => r.userId === member.id)
      const demoted = rows.find((r) => r.userId === owner.id)
      expect(newOwner?.role).toBe('owner')
      expect(newOwner?.channelRole).toBe('owner')
      expect(demoted?.role).toBe('admin')
      expect(demoted?.channelRole).toBe('editor')
    } finally {
      if (chatId) {
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [owner.id, member.id]))
    }
  })
})

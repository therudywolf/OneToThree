import { randomBytes } from 'node:crypto'
import { and, asc, eq, inArray, max, ne } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  getChatById,
  getMemberRole,
  type ChatMemberRole,
} from '../lib/chat-permissions.js'
import { broadcastToUsers } from '../ws/registry.js'
import { uuidSchema } from '../lib/zod-uuid.js'

const patchRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
})

const wrappedKeySchema = z.object({
  encrypted_group_key: z.string().min(1),
})

const createChatSchema = z
  .object({
    type: z.enum(['direct_e2e', 'group_e2e', 'public_open']),
    name: z.string().max(256).optional().nullable(),
    member_ids: z.array(uuidSchema).optional(),
    members: z
      .array(
        z.object({
          userId: uuidSchema,
          encryptedGroupKey: z.string().min(1),
        })
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'direct_e2e') {
      if (
        !data.member_ids ||
        (data.member_ids.length !== 1 && data.member_ids.length !== 2)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DIRECT_REQUIRES_TWO_MEMBERS',
          path: ['member_ids'],
        })
      }
    } else if (data.type === 'group_e2e') {
      if (!data.members || data.members.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'GROUP_REQUIRES_MEMBERS',
          path: ['members'],
        })
      }
    } else if (data.type === 'public_open') {
      if (!data.member_ids?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_REQUIRES_MEMBERS',
          path: ['member_ids'],
        })
      }
    }
  })

function isGroupType(t: string): boolean {
  return t === 'group_e2e'
}

/** If a direct_e2e chat already links exactly these two users, return it (idempotent create). */
async function findExistingDirectE2EBetween(
  userA: string,
  userB: string
): Promise<{ id: string; name: string | null; type: string } | null> {
  const aRows = await db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(and(eq(chatMembers.userId, userA), eq(chats.type, 'direct_e2e')))

  const bIds = new Set(
    (
      await db
        .select({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(eq(chatMembers.userId, userB))
    ).map((r) => r.chatId)
  )

  for (const { chatId } of aRows) {
    if (!bIds.has(chatId)) continue
    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId))
    if (members.length !== 2) continue
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)
    if (chat) return chat
  }
  return null
}

async function generateUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomBytes(18).toString('base64url')
    const [hit] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.inviteCode, code))
      .limit(1)
    if (!hit) return code
  }
  throw new Error('INVITE_CODE_COLLISION')
}

function canKick(actor: ChatMemberRole, target: ChatMemberRole): boolean {
  if (target === 'owner') return false
  if (actor === 'owner') return true
  if (actor === 'admin' && target === 'member') return true
  return false
}

export const chatsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        type: chats.type,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
        inviteCode: chats.inviteCode,
        myRole: chatMembers.role,
      })
      .from(chats)
      .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
      .where(eq(chatMembers.userId, user.id))

    const chatIds = rows.map((r) => r.id)
    const memberRows =
      chatIds.length === 0
        ? []
        : await db
            .select({
              chatId: chatMembers.chatId,
              userId: chatMembers.userId,
            })
            .from(chatMembers)
            .where(inArray(chatMembers.chatId, chatIds))

    const memberMap = new Map<string, string[]>()
    for (const m of memberRows) {
      const list = memberMap.get(m.chatId) ?? []
      list.push(m.userId)
      memberMap.set(m.chatId, list)
    }

    const lastActivityRows =
      chatIds.length === 0
        ? []
        : await db
            .select({
              chatId: messages.chatId,
              lastAt: max(messages.createdAt),
            })
            .from(messages)
            .where(inArray(messages.chatId, chatIds))
            .groupBy(messages.chatId)

    const lastMessageAtByChat = new Map<string, string | null>()
    for (const r of lastActivityRows) {
      const t = r.lastAt
      lastMessageAtByChat.set(
        r.chatId,
        t instanceof Date ? t.toISOString() : t != null ? String(t) : null
      )
    }

    return reply.send({
      chats: rows.map((c) => {
        const isGroup = isGroupType(c.type)
        const showInvite =
          isGroup &&
          (c.myRole === 'owner' || c.myRole === 'admin') &&
          c.inviteCode
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          is_group: isGroup,
          member_ids: memberMap.get(c.id) ?? [],
          encrypted_group_key: c.encryptedGroupKey,
          last_message_at: lastMessageAtByChat.get(c.id) ?? null,
          my_role: c.myRole,
          invite_code: showInvite ? c.inviteCode : null,
        }
      }),
    })
  })

  app.get('/join/:code', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const { code } = request.params as { code: string }
    const trimmed = code?.trim()
    if (!trimmed) {
      return reply.status(400).send({ error: 'INVALID_CODE' })
    }

    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.inviteCode, trimmed))
      .limit(1)

    if (!chat || chat.type !== 'group_e2e') {
      return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
    }

    const existing = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, user.id))
      )
      .limit(1)

    if (existing.length) {
      return reply.send({
        chat_id: chat.id,
        already_member: true,
      })
    }

    await db
      .insert(chatMembers)
      .values({
        chatId: chat.id,
        userId: user.id,
        encryptedGroupKey: null,
        role: 'member',
      })
      .onConflictDoNothing()

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chat.id))
    ).map((r) => r.userId)

    broadcastToUsers(memberIds, { type: 'chats_updated' })

    return reply.send({
      chat_id: chat.id,
      already_member: false,
    })
  })

  app.post('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = createChatSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { type, name } = parsed.data

    if (type === 'group_e2e') {
      const members = parsed.data.members
      if (!members) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const keyByUser = new Map(
        members.map((m) => [m.userId, m.encryptedGroupKey] as const)
      )
      if (keyByUser.size !== members.length) {
        return reply.status(400).send({ error: 'DUPLICATE_MEMBER' })
      }
      if (!keyByUser.has(user.id)) {
        return reply.status(400).send({ error: 'CREATOR_NOT_IN_MEMBERS' })
      }

      const uniqueIds = [...keyByUser.keys()]

      const existingUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, uniqueIds))
      if (existingUsers.length !== uniqueIds.length) {
        return reply.status(400).send({ error: 'UNKNOWN_MEMBER' })
      }

      const [created] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(chats)
          .values({
            type: 'group_e2e',
            name: name ?? null,
          })
          .returning()
        const chat = inserted[0]
        if (!chat) throw new Error('INSERT_CHAT_FAILED')

        await tx.insert(chatMembers).values(
          uniqueIds.map((uid) => ({
            chatId: chat.id,
            userId: uid,
            encryptedGroupKey: keyByUser.get(uid) ?? null,
            role: uid === user.id ? ('owner' as const) : ('member' as const),
          }))
        )
        return inserted
      })

      if (!created) {
        return reply.status(500).send({ error: 'CREATE_FAILED' })
      }

      broadcastToUsers(uniqueIds, { type: 'chats_updated' })

      return reply.status(201).send({
        chat: {
          id: created.id,
          name: created.name,
          type: created.type,
          is_group: true,
          member_ids: uniqueIds,
          my_role: 'owner' as const,
        },
      })
    }

    const member_ids = parsed.data.member_ids
    if (!member_ids) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const authId = user.id
    let uniqueIds: string[]
    if (type === 'direct_e2e') {
      const mids = member_ids
      if (mids.length === 1) {
        const peer = mids[0]
        if (!peer || peer === authId) {
          return reply
            .status(400)
            .send({ error: 'DIRECT_REQUIRES_TWO_MEMBERS' })
        }
        uniqueIds = [authId, peer]
      } else if (mids.length === 2) {
        if (!mids.includes(authId)) {
          return reply
            .status(400)
            .send({ error: 'DIRECT_REQUIRES_AUTH_MEMBER' })
        }
        const peer = mids.find((id) => id !== authId)
        if (!peer) {
          return reply
            .status(400)
            .send({ error: 'DIRECT_REQUIRES_TWO_MEMBERS' })
        }
        uniqueIds = [authId, peer]
      } else {
        return reply
          .status(400)
          .send({ error: 'DIRECT_REQUIRES_TWO_MEMBERS' })
      }
    } else {
      const memberSet = new Set(member_ids)
      memberSet.add(authId)
      uniqueIds = [...memberSet]
    }

    if (type === 'direct_e2e' && uniqueIds.length !== 2) {
      return reply
        .status(400)
        .send({ error: 'DIRECT_REQUIRES_TWO_MEMBERS' })
    }
    if (type === 'public_open' && uniqueIds.length < 1) {
      return reply.status(400).send({ error: 'PUBLIC_REQUIRES_MEMBERS' })
    }

    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, uniqueIds))
    if (existingUsers.length !== uniqueIds.length) {
      return reply.status(400).send({ error: 'UNKNOWN_MEMBER' })
    }

    if (type === 'direct_e2e') {
      const peerId = uniqueIds.find((id) => id !== authId)
      if (peerId) {
        const existingDirect = await findExistingDirectE2EBetween(authId, peerId)
        if (existingDirect) {
          return reply.status(201).send({
            chat: {
              id: existingDirect.id,
              name: existingDirect.name,
              type: existingDirect.type,
              is_group: false,
              member_ids: uniqueIds,
              my_role: 'member' as const,
            },
          })
        }
      }
    }

    const [created] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chats)
        .values({
          type,
          name: name ?? null,
        })
        .returning()
      const chat = inserted[0]
      if (!chat) throw new Error('INSERT_CHAT_FAILED')

      await tx.insert(chatMembers).values(
        uniqueIds.map((uid) => ({
          chatId: chat.id,
          userId: uid,
          encryptedGroupKey: null as string | null,
          role: 'member' as const,
        }))
      )
      return inserted
    })

    if (!created) {
      return reply.status(500).send({ error: 'CREATE_FAILED' })
    }

    broadcastToUsers(uniqueIds, { type: 'chats_updated' })

    return reply.status(201).send({
      chat: {
        id: created.id,
        name: created.name,
        type: created.type,
        is_group: isGroupType(created.type),
        member_ids: uniqueIds,
        my_role: 'member' as const,
      },
    })
  })

  app.post('/:chatId/invite', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'group_e2e') {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    const role = await getMemberRole(chatId, user.id)
    if (role !== 'owner' && role !== 'admin') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    let code = chat.inviteCode
    if (!code) {
      code = await generateUniqueInviteCode()
      await db
        .update(chats)
        .set({ inviteCode: code })
        .where(eq(chats.id, chatId))
    }

    return reply.send({ invite_code: code })
  })

  app.post('/:chatId/leave', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1)
    if (!chat) {
      return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })
    }

    const [myRow] = await db
      .select({
        userId: chatMembers.userId,
        role: chatMembers.role,
      })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)

    if (!myRow) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    if (chat.type === 'group_e2e' && myRow.role === 'owner') {
      const others = await db
        .select({
          userId: chatMembers.userId,
          role: chatMembers.role,
          joinedAt: chatMembers.joinedAt,
        })
        .from(chatMembers)
        .where(
          and(eq(chatMembers.chatId, chatId), ne(chatMembers.userId, user.id))
        )

      if (others.length > 0) {
        const sorted = [...others].sort((a, b) => {
          const rank = (r: string) => (r === 'admin' ? 0 : 1)
          const d = rank(a.role) - rank(b.role)
          if (d !== 0) return d
          const ta =
            a.joinedAt instanceof Date
              ? a.joinedAt.getTime()
              : new Date(a.joinedAt).getTime()
          const tb =
            b.joinedAt instanceof Date
              ? b.joinedAt.getTime()
              : new Date(b.joinedAt).getTime()
          return ta - tb
        })
        const nextOwner = sorted[0]
        if (!nextOwner) {
          return reply.status(500).send({ error: 'LEAVE_FAILED' })
        }

        await db.transaction(async (tx) => {
          await tx
            .update(chatMembers)
            .set({ role: 'owner' })
            .where(
              and(
                eq(chatMembers.chatId, chatId),
                eq(chatMembers.userId, nextOwner.userId)
              )
            )
          await tx
            .delete(chatMembers)
            .where(
              and(
                eq(chatMembers.chatId, chatId),
                eq(chatMembers.userId, user.id)
              )
            )
        })

        const remaining = await db
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))

        broadcastToUsers(
          [...remaining.map((r) => r.userId), user.id],
          { type: 'chats_updated' }
        )
        return reply.send({ ok: true })
      }
    }

    const deleted = await db
      .delete(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .returning({ chatId: chatMembers.chatId })

    if (!deleted.length) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    const remaining = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId))

    if (remaining.length === 0) {
      await db.delete(messages).where(eq(messages.chatId, chatId))
      await db.delete(chats).where(eq(chats.id, chatId))
    } else {
      broadcastToUsers(
        [...remaining.map((r) => r.userId), user.id],
        { type: 'chats_updated' }
      )
    }

    return reply.send({ ok: true })
  })

  app.patch('/:chatId/members/:userId/role', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId, userId: targetUserId } = request.params as {
      chatId: string
      userId: string
    }

    const parsed = patchRoleSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const newRole = parsed.data.role as ChatMemberRole

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'group_e2e') {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    const targetRole = await getMemberRole(chatId, targetUserId)
    if (!actorRole || !targetRole) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    if (actorRole === 'member') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    if (targetUserId === user.id) {
      return reply.status(400).send({ error: 'CANNOT_PATCH_SELF' })
    }

    if (newRole === 'owner') {
      if (actorRole !== 'owner') {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }
      await db.transaction(async (tx) => {
        await tx
          .update(chatMembers)
          .set({ role: 'admin' })
          .where(
            and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
          )
        await tx
          .update(chatMembers)
          .set({ role: 'owner' })
          .where(
            and(
              eq(chatMembers.chatId, chatId),
              eq(chatMembers.userId, targetUserId)
            )
          )
      })
      const memberIds = (
        await db
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))
      ).map((r) => r.userId)
      broadcastToUsers(memberIds, { type: 'chats_updated' })
      return reply.send({ ok: true })
    }

    if (targetRole === 'owner') {
      return reply.status(400).send({ error: 'TRANSFER_USE_OWNER_ROLE' })
    }

    if (actorRole === 'admin') {
      if (targetRole !== 'member') {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }
      if (newRole !== 'admin' && newRole !== 'member') {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }
      await db
        .update(chatMembers)
        .set({ role: newRole })
        .where(
          and(
            eq(chatMembers.chatId, chatId),
            eq(chatMembers.userId, targetUserId)
          )
        )
      const memberIds = (
        await db
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))
      ).map((r) => r.userId)
      broadcastToUsers(memberIds, { type: 'chats_updated' })
      return reply.send({ ok: true })
    }

    if (actorRole === 'owner') {
      await db
        .update(chatMembers)
        .set({ role: newRole })
        .where(
          and(
            eq(chatMembers.chatId, chatId),
            eq(chatMembers.userId, targetUserId)
          )
        )
      const memberIds = (
        await db
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))
      ).map((r) => r.userId)
      broadcastToUsers(memberIds, { type: 'chats_updated' })
      return reply.send({ ok: true })
    }

    return reply.status(403).send({ error: 'FORBIDDEN' })
  })

  app.delete('/:chatId/members/:userId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId, userId: targetUserId } = request.params as {
      chatId: string
      userId: string
    }

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'group_e2e') {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    if (targetUserId === user.id) {
      return reply.status(400).send({ error: 'USE_LEAVE' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    const targetRole = await getMemberRole(chatId, targetUserId)
    if (!actorRole || !targetRole) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    if (!canKick(actorRole, targetRole)) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    await db
      .delete(chatMembers)
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          eq(chatMembers.userId, targetUserId)
        )
      )

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)

    broadcastToUsers([...memberIds, targetUserId], { type: 'chats_updated' })
    return reply.send({ ok: true })
  })

  app.put('/:chatId/members/:userId/wrapped-key', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId, userId: targetUserId } = request.params as {
      chatId: string
      userId: string
    }

    const parsed = wrappedKeySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'group_e2e') {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    if (targetUserId === user.id) {
      return reply.status(400).send({ error: 'FORBIDDEN' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const targetOk = await getMemberRole(chatId, targetUserId)
    if (!targetOk) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    await db
      .update(chatMembers)
      .set({ encryptedGroupKey: parsed.data.encrypted_group_key })
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          eq(chatMembers.userId, targetUserId)
        )
      )

    broadcastToUsers([user.id, targetUserId], { type: 'chats_updated' })
    return reply.send({ ok: true })
  })

  app.delete('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

    const chat = await getChatById(chatId)
    if (!chat) {
      return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })
    }

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    if (chat.type === 'group_e2e') {
      const r = await getMemberRole(chatId, user.id)
      if (r !== 'owner') {
        return reply.status(403).send({ error: 'OWNER_ONLY' })
      }
    }

    const allMembers = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId))

    await db.delete(messages).where(eq(messages.chatId, chatId))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))

    broadcastToUsers(
      allMembers.map((m) => m.userId),
      { type: 'chats_updated' }
    )

    return reply.send({ ok: true })
  })

  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

    const memberOk = await db
      .select({
        myRole: chatMembers.role,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
      })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)
    if (!chat) {
      return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })
    }

    const members = await db
      .select({
        userId: users.id,
        username: users.username,
        ecdhPublicKeyJwk: users.ecdhPublicKeyJwk,
        avatarKey: users.avatarKey,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
        role: chatMembers.role,
      })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(eq(chatMembers.chatId, chatId))
      .orderBy(asc(chatMembers.joinedAt))

    const showInvite =
      chat.type === 'group_e2e' &&
      (memberOk[0].myRole === 'owner' || memberOk[0].myRole === 'admin')

    return reply.send({
      chat: {
        id: chat.id,
        name: chat.name,
        type: chat.type,
        is_group: isGroupType(chat.type),
        invite_code: showInvite ? chat.inviteCode : null,
        my_role: memberOk[0].myRole,
      },
      members: members.map((m) => ({
        user_id: m.userId,
        username: m.username,
        ecdh_public_key_jwk: m.ecdhPublicKeyJwk,
        avatar_key: m.avatarKey,
        encrypted_group_key: m.encryptedGroupKey,
        role: m.role,
      })),
    })
  })
}

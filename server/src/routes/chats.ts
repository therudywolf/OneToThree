import { randomBytes } from 'node:crypto'
import { and, asc, count, desc, eq, ilike, inArray, isNull, max, ne, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatFavorites, chatMembers, chats, messages, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  getChatById,
  getMemberRole,
  type ChatMemberRole,
} from '../lib/chat-permissions.js'
import { isBlocked } from '../lib/block-check.js'
import { broadcastToUsers } from '../ws/registry.js'
import { uuidSchema } from '../lib/zod-uuid.js'

const patchRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
})

const wrappedKeySchema = z.object({
  encrypted_group_key: z.string().min(1),
})

const invitePostSchema = z.object({
  invite_one_time: z.boolean().optional(),
})
const inviteSlugPatchSchema = z.object({
  invite_slug: z.string().trim().min(4).max(32).regex(/^[a-z0-9_]+$/),
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
      // Allow 1 member (self-chat) or 2 members (direct chat)
      if (
        !data.member_ids ||
        data.member_ids.length < 1 ||
        data.member_ids.length > 2
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DIRECT_REQUIRES_ONE_OR_TWO_MEMBERS',
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
  return t === 'group_e2e' || t === 'public_open'
}

/** If a direct_e2e chat already links exactly these two users, return it (idempotent create). */
async function findExistingDirectE2EBetween(
  userA: string,
  userB: string
): Promise<{ id: string; name: string | null; type: string } | null> {
  const rows = await db
    .select({
      id: chats.id,
      name: chats.name,
      type: chats.type,
    })
    .from(chats)
    .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
    .where(
      and(
        eq(chats.type, 'direct_e2e'),
        inArray(
          chats.id,
          db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(eq(chatMembers.userId, userA))
        ),
        inArray(
          chats.id,
          db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(eq(chatMembers.userId, userB))
        )
      )
    )
    .groupBy(chats.id, chats.name, chats.type)
    .having(sql`count(${chatMembers.userId}) = 2`)
    .limit(1)

  return rows[0] ?? null
}

/** Find or create a self-chat (Saved Messages) for the given user. Returns the chat row. */
async function getOrCreateSelfChat(userId: string) {
  // Single-query self-chat lookup: pick direct_e2e chats where the user is a
  // member AND the chat has exactly one member total (i.e. just the user).
  // Replaces the previous N+1 loop (one members-query per direct chat).
  const selfChats = await db
    .select({
      id: chats.id,
      name: chats.name,
      type: chats.type,
      inviteCode: chats.inviteCode,
      inviteOneTime: chats.inviteOneTime,
    })
    .from(chats)
    .innerJoin(chatMembers, eq(chats.id, chatMembers.chatId))
    .where(and(eq(chatMembers.userId, userId), eq(chats.type, 'direct_e2e')))
    .groupBy(chats.id, chats.name, chats.type, chats.inviteCode, chats.inviteOneTime)
    .having(sql`count(${chatMembers.userId}) = 1`)
    .limit(1)
  if (selfChats[0]) {
    return { chat: selfChats[0], created: false }
  }

  const [created] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(chats)
      .values({ type: 'direct_e2e', name: 'Saved Messages' })
      .returning()
    const chat = inserted[0]
    if (!chat) throw new Error('INSERT_CHAT_FAILED')
    await tx.insert(chatMembers).values({
      chatId: chat.id,
      userId,
      encryptedGroupKey: null,
      role: 'owner',
    })
    return inserted
  })

  if (!created) throw new Error('CREATE_FAILED')
  return { chat: created, created: true }
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

type UserChatRow = {
  id: string
  name: string | null
  type: string
  keyEpoch: number
  encryptedGroupKey: string | null
  inviteCode: string | null
  inviteSlug: string | null
  myRole: ChatMemberRole
  isFavorite: boolean
  mutedUntil: string | null
}

async function loadUserChats(userId: string): Promise<UserChatRow[]> {
  const rows = await db
    .select({
      id: chats.id,
      name: chats.name,
      type: chats.type,
      keyEpoch: chats.keyEpoch,
      encryptedGroupKey: chatMembers.encryptedGroupKey,
      inviteCode: chats.inviteCode,
      inviteSlug: chats.inviteSlug,
      myRole: chatMembers.role,
      favoriteUserId: chatFavorites.userId,
      mutedUntil: chatMembers.mutedUntil,
    })
    .from(chats)
    .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
    .leftJoin(
      chatFavorites,
      and(eq(chatFavorites.chatId, chats.id), eq(chatFavorites.userId, userId))
    )
    .where(eq(chatMembers.userId, userId))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    keyEpoch: r.keyEpoch ?? 0,
    encryptedGroupKey: r.encryptedGroupKey,
    inviteCode: r.inviteCode,
    inviteSlug: r.inviteSlug,
    myRole: r.myRole,
    isFavorite: Boolean(r.favoriteUserId),
    mutedUntil: r.mutedUntil instanceof Date ? r.mutedUntil.toISOString() : r.mutedUntil,
  }))
}

export const chatsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await loadUserChats(user.id)

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

    // Unread count per chat: messages not sent by user, not yet read,
    // delivered to this device (or any device for group chats as fallback).
    const unreadCountByChat = new Map<string, number>()
    if (chatIds.length > 0) {
      try {
        const unreadRows = await db
          .select({
            chatId: messages.chatId,
            cnt: count(),
          })
          .from(messages)
          .where(
            and(
              inArray(messages.chatId, chatIds),
              isNull(messages.readAt),
              ne(messages.senderId, user.id)
            )
          )
          .groupBy(messages.chatId)
        for (const r of unreadRows) {
          unreadCountByChat.set(r.chatId, r.cnt)
        }
      } catch {
        // non-fatal: unread counts fall back to 0
      }
    }

    return reply.send({
      chats: rows.map((c) => {
        const isGroup = isGroupType(c.type)
        const memberIds = memberMap.get(c.id) ?? []
        const isSelf =
          !isGroup &&
          c.type === 'direct_e2e' &&
          memberIds.length === 1 &&
          memberIds[0] === user.id
        const showInvite =
          isGroup &&
          (c.myRole === 'owner' || c.myRole === 'admin') &&
          c.inviteCode
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          is_group: isGroup,
          member_ids: memberIds,
          encrypted_group_key: c.encryptedGroupKey,
          is_favorite: c.isFavorite,
          is_self: isSelf,
          muted_until: c.mutedUntil ?? null,
          last_message_at: lastMessageAtByChat.get(c.id) ?? null,
          unread_count: unreadCountByChat.get(c.id) ?? 0,
          my_role: c.myRole,
          invite_code: showInvite ? c.inviteCode : null,
          invite_slug: showInvite ? c.inviteSlug : null,
          key_epoch: c.keyEpoch,
        }
      }),
    })
  })

  /** GET /self — returns or creates "Saved Messages" (self-chat) for the current user. */
  app.get('/self', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const { chat, created } = await getOrCreateSelfChat(user.id)

    return reply.status(created ? 201 : 200).send({
      chat: {
        id: chat.id,
        name: chat.name ?? 'Saved Messages',
        type: chat.type,
        is_group: false,
        is_self: true,
        member_ids: [user.id],
        my_role: 'owner',
      },
    })
  })

  /** GET /favorites — current user's favorite chats sorted by favorite time desc. */
  app.get('/favorites', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        type: chats.type,
        keyEpoch: chats.keyEpoch,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
        inviteCode: chats.inviteCode,
        inviteSlug: chats.inviteSlug,
        myRole: chatMembers.role,
        favoriteAt: chatFavorites.createdAt,
      })
      .from(chatFavorites)
      .innerJoin(chats, eq(chats.id, chatFavorites.chatId))
      .innerJoin(
        chatMembers,
        and(eq(chatMembers.chatId, chats.id), eq(chatMembers.userId, user.id))
      )
      .where(eq(chatFavorites.userId, user.id))
      .orderBy(desc(chatFavorites.createdAt))

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
          is_favorite: true,
          favorited_at:
            c.favoriteAt instanceof Date
              ? c.favoriteAt.toISOString()
              : c.favoriteAt != null
              ? String(c.favoriteAt)
              : null,
          my_role: c.myRole,
          invite_code: showInvite ? c.inviteCode : null,
          invite_slug: showInvite ? c.inviteSlug : null,
          key_epoch: c.keyEpoch ?? 0,
        }
      }),
    })
  })

  app.post('/:chatId/favorite', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const [membership] = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!membership) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    await db
      .insert(chatFavorites)
      .values({ userId: user.id, chatId })
      .onConflictDoNothing()

    broadcastToUsers([user.id], { type: 'chats_updated' })
    return reply.send({ ok: true, is_favorite: true })
  })

  app.delete('/:chatId/favorite', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    await db
      .delete(chatFavorites)
      .where(and(eq(chatFavorites.chatId, chatId), eq(chatFavorites.userId, user.id)))

    broadcastToUsers([user.id], { type: 'chats_updated' })
    return reply.send({ ok: true, is_favorite: false })
  })

  /**
   * PATCH /:chatId/mute — toggle per-user mute for a chat. Accepts:
   *   { muted_until: string | null }  — ISO 8601 timestamp or null to unmute.
   *   { muted_until: 'forever' }      — shortcut: set far-future (year 9999).
   * Notification suppression is purely a client-side concern; the server
   * just persists the flag and echoes it via `chats_updated`.
   */
  const muteBodySchema = z.object({
    muted_until: z.union([z.string().datetime(), z.literal('forever'), z.null()]),
  })
  app.patch('/:chatId/mute', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = muteBodySchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const { chatId } = params.data
    const { muted_until } = body.data

    const [membership] = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!membership) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    const mutedUntilValue: Date | null =
      muted_until === null
        ? null
        : muted_until === 'forever'
          ? new Date('9999-12-31T23:59:59Z')
          : new Date(muted_until)

    await db
      .update(chatMembers)
      .set({ mutedUntil: mutedUntilValue })
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))

    broadcastToUsers([user.id], { type: 'chats_updated' })
    return reply.send({
      ok: true,
      muted_until: mutedUntilValue ? mutedUntilValue.toISOString() : null,
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
      .where(or(eq(chats.inviteCode, trimmed), eq(chats.inviteSlug, trimmed)))
      .limit(1)

    if (!chat || (chat.type !== 'group_e2e' && chat.type !== 'public_open')) {
      return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
    }

    const alreadyMember = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, user.id))
      )
      .limit(1)

    if (alreadyMember.length) {
      return reply.send({
        chat_id: chat.id,
        already_member: true,
      })
    }

    const outcome = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chatMembers)
        .values({
          chatId: chat.id,
          userId: user.id,
          encryptedGroupKey: null,
          role: 'member',
        })
        .onConflictDoNothing()
        .returning({ userId: chatMembers.userId })

      if (inserted.length === 0) {
        const again = await tx
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(
            and(
              eq(chatMembers.chatId, chat.id),
              eq(chatMembers.userId, user.id)
            )
          )
          .limit(1)
        if (again.length) {
          return { kind: 'already_member' as const }
        }
        throw new Error('JOIN_RACE')
      }

      if (chat.inviteOneTime) {
        await tx
          .update(chats)
          .set({ inviteCode: null })
          .where(eq(chats.id, chat.id))
      }

      return { kind: 'joined' as const }
    })

    if (outcome.kind === 'already_member') {
      return reply.send({
        chat_id: chat.id,
        already_member: true,
      })
    }

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chat.id))
    ).map((r) => r.userId)

    broadcastToUsers(memberIds, { type: 'chats_updated' })

    if (chat.type === 'group_e2e') {
      // Notify existing members (excluding the joiner) so their clients can
      // deliver the group encryption key to the new member.
      const existingIds = memberIds.filter((id) => id !== user.id)
      broadcastToUsers(existingIds, {
        type: 'member_joined',
        chat_id: chat.id,
        user_id: user.id,
      })
    }

    return reply.send({
      chat_id: chat.id,
      already_member: false,
    })
  })

  app.post('/', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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

      // Block check: creator cannot add users with whom there is a block relationship
      for (const uid of uniqueIds) {
        if (uid === user.id) continue
        if (await isBlocked(user.id, uid)) {
          return reply.status(403).send({ error: 'BLOCKED' })
        }
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
        // Self-chat: single member_id equals current user → redirect to Saved Messages
        if (!peer) {
          return reply.status(400).send({ error: 'INVALID_BODY' })
        }
        if (peer === authId) {
          const { chat } = await getOrCreateSelfChat(authId)
          return reply.status(201).send({
            chat: {
              id: chat.id,
              name: chat.name ?? 'Saved Messages',
              type: chat.type,
              is_group: false,
              is_self: true,
              member_ids: [authId],
              my_role: 'owner' as const,
            },
          })
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
          // Both ids are authId — treat as self-chat
          const { chat } = await getOrCreateSelfChat(authId)
          return reply.status(201).send({
            chat: {
              id: chat.id,
              name: chat.name ?? 'Saved Messages',
              type: chat.type,
              is_group: false,
              is_self: true,
              member_ids: [authId],
              my_role: 'owner' as const,
            },
          })
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

    // Block check for direct and public chats
    for (const uid of uniqueIds) {
      if (uid === authId) continue
      if (await isBlocked(authId, uid)) {
        return reply.status(403).send({ error: 'BLOCKED' })
      }
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

    const isPublicOpen = type === 'public_open'
    const inviteCode = isPublicOpen ? await generateUniqueInviteCode() : null

    const [created] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chats)
        .values({
          type,
          name: name ?? null,
          ...(inviteCode ? { inviteCode } : {}),
        })
        .returning()
      const chat = inserted[0]
      if (!chat) throw new Error('INSERT_CHAT_FAILED')

      await tx.insert(chatMembers).values(
        uniqueIds.map((uid) => ({
          chatId: chat.id,
          userId: uid,
          encryptedGroupKey: null as string | null,
          role: isPublicOpen && uid === authId ? ('owner' as const) : ('member' as const),
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
        my_role: isPublicOpen ? ('owner' as const) : ('member' as const),
        invite_code: inviteCode,
      },
    })
  })

  app.post('/:chatId/invite', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const parsedBody = invitePostSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const wantOneTime = parsedBody.data.invite_one_time

    const chat = await getChatById(chatId)
    if (!chat || (chat.type !== 'group_e2e' && chat.type !== 'public_open')) {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    const role = await getMemberRole(chatId, user.id)
    if (role !== 'owner' && role !== 'admin') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    let code = chat.inviteCode
    if (!code) {
      // Atomic: only write if invite_code is still NULL so concurrent requests
      // don't silently overwrite each other.
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomBytes(18).toString('base64url')
        const updated = await db
          .update(chats)
          .set({
            inviteCode: candidate,
            ...(typeof wantOneTime === 'boolean' ? { inviteOneTime: wantOneTime } : {}),
          })
          .where(and(eq(chats.id, chatId), sql`${chats.inviteCode} IS NULL`))
          .returning({ inviteCode: chats.inviteCode })
        if (updated.length > 0) {
          code = candidate
          break
        }
        // Another request beat us; read back what they wrote.
        const [existing] = await db
          .select({ inviteCode: chats.inviteCode })
          .from(chats)
          .where(eq(chats.id, chatId))
          .limit(1)
        if (existing?.inviteCode) {
          code = existing.inviteCode
          break
        }
      }
    } else if (typeof wantOneTime === 'boolean') {
      await db
        .update(chats)
        .set({ inviteOneTime: wantOneTime })
        .where(eq(chats.id, chatId))
    }

    const [fresh] = await db
      .select({ inviteCode: chats.inviteCode })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)
    if (!fresh?.inviteCode) {
      return reply.status(500).send({ error: 'INVITE_CODE_MISSING' })
    }

    return reply.send({ invite_code: fresh.inviteCode })
  })

  app.patch('/:chatId/invite-slug', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const parsedBody = inviteSlugPatchSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) return reply.status(400).send({ error: 'INVALID_INVITE_SLUG' })
    const { chatId } = params.data
    const nextSlug = parsedBody.data.invite_slug.trim().toLowerCase()

    const chat = await getChatById(chatId)
    if (!chat || (chat.type !== 'channel' && chat.type !== 'public_open')) {
      return reply.status(400).send({ error: 'NOT_CHANNEL_CHAT' })
    }
    const role = await getMemberRole(chatId, user.id)
    if (role !== 'owner') return reply.status(403).send({ error: 'FORBIDDEN' })

    try {
      await db.update(chats).set({ inviteSlug: nextSlug }).where(eq(chats.id, chatId))
    } catch {
      return reply.status(409).send({ error: 'INVITE_SLUG_TAKEN' })
    }

    return reply.send({ invite_slug: nextSlug })
  })

  app.post('/:chatId/leave', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

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

    if ((chat.type === 'group_e2e' || chat.type === 'public_open') && myRow.role === 'owner') {
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
    const params = z.object({ chatId: uuidSchema, userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId, userId: targetUserId } = params.data

    const parsed = patchRoleSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const newRole = parsed.data.role as ChatMemberRole

    const chat = await getChatById(chatId)
    if (!chat || !isGroupType(chat.type)) {
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
    const params = z.object({ chatId: uuidSchema, userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId, userId: targetUserId } = params.data

    const chat = await getChatById(chatId)
    if (!chat || !isGroupType(chat.type)) {
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

    let nextKeyEpoch: number | null = null
    if (chat.type === 'group_e2e') {
      const bumped = await db
        .update(chats)
        .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
        .where(eq(chats.id, chatId))
        .returning({ keyEpoch: chats.keyEpoch })
      nextKeyEpoch = bumped[0]?.keyEpoch ?? null
    }

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)

    const notifyIds = [...memberIds, targetUserId]
    broadcastToUsers(notifyIds, { type: 'chats_updated' })
    if (nextKeyEpoch != null) {
      broadcastToUsers(notifyIds, {
        type: 'group_key_epoch',
        chat_id: chatId,
        key_epoch: nextKeyEpoch,
      })
    }
    return reply.send({ ok: true })
  })

  app.put('/:chatId/members/:userId/wrapped-key', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema, userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId, userId: targetUserId } = params.data

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
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

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

    if (isGroupType(chat.type)) {
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
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

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
      isGroupType(chat.type) &&
      (memberOk[0].myRole === 'owner' || memberOk[0].myRole === 'admin')

    return reply.send({
      chat: {
        id: chat.id,
        name: chat.name,
        type: chat.type,
        is_group: isGroupType(chat.type),
        invite_code: showInvite ? chat.inviteCode : null,
        invite_slug: showInvite ? chat.inviteSlug : null,
        invite_one_time: showInvite ? chat.inviteOneTime : null,
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

  // Public group / channel discovery
  app.get('/discover', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const qSchema = z.object({
      q: z.string().max(100).optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
      offset: z.coerce.number().min(0).default(0),
    })
    const parsed = qSchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_QUERY' })
    const { q, limit, offset } = parsed.data

    const memberCountSq = db
      .select({ chatId: chatMembers.chatId, memberCount: count(chatMembers.userId).as('member_count') })
      .from(chatMembers)
      .groupBy(chatMembers.chatId)
      .as('member_count_sq')

    const baseWhere = and(
      or(eq(chats.type, 'public_open'), eq(chats.type, 'channel')),
      q ? ilike(chats.name, `%${q}%`) : undefined
    )

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        type: chats.type,
        inviteCode: chats.inviteCode,
        inviteSlug: chats.inviteSlug,
        memberCount: memberCountSq.memberCount,
      })
      .from(chats)
      .leftJoin(memberCountSq, eq(chats.id, memberCountSq.chatId))
      .where(baseWhere)
      .orderBy(desc(memberCountSq.memberCount))
      .limit(limit)
      .offset(offset)

    return reply.send(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        invite_code: r.inviteCode,
        invite_slug: r.inviteSlug,
        member_count: Number(r.memberCount ?? 0),
      }))
    )
  })
}

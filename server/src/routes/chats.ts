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
import { scheduleMediaCleanupForChat } from '../lib/media-cleanup.js'

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
    type: z.enum(['direct_e2e', 'group_e2e', 'public_open', 'channel']),
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
    } else if (data.type === 'public_open' || data.type === 'channel') {
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
  return t === 'group_e2e' || t === 'public_open' || t === 'channel'
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
    // Require the canonical "Saved Messages" name so a direct chat orphaned by a
    // peer's account deletion (which also collapses to a single member) is never
    // returned as — or merged into — the viewer's real self-chat.
    .where(
      and(
        eq(chatMembers.userId, userId),
        eq(chats.type, 'direct_e2e'),
        eq(chats.name, 'Saved Messages')
      )
    )
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

// Tell the remaining members of a SECTOR (group_e2e) chat to re-key after a
// member departs (kick or leave) so the departed member can no longer read
// future traffic. The caller bumps `chats.key_epoch` INSIDE the same
// transaction as the membership change — so the epoch can never lag the
// membership state across a crash — and passes the resulting epoch here to
// broadcast once that transaction has committed. A null epoch (no row updated)
// is a no-op. Caller is responsible for restricting this to group_e2e chats.
function broadcastKeyEpoch(
  chatId: string,
  keyEpoch: number | null,
  notifyIds: string[]
): void {
  if (keyEpoch == null) return
  broadcastToUsers(notifyIds, {
    type: 'group_key_epoch',
    chat_id: chatId,
    key_epoch: keyEpoch,
  })
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
  myChannelRole: string | null
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
      myChannelRole: chatMembers.channelRole,
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
    myChannelRole: r.myChannelRole ?? null,
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
    // Unread count per chat. This is derived from messages.read_at, which is
    // ONLY ever set for direct_e2e chats (read receipts are direct-only). For
    // group/channel/public chats read_at stays NULL forever, so counting them
    // here yielded a monotonic lifetime-message count that never cleared.
    // Restrict the query to direct chats; group-type unread defaults to 0 until
    // a per-member read cursor lands (see BUG_BACKLOG H2 "proper").
    const directChatIds = rows.filter((c) => c.type === 'direct_e2e').map((c) => c.id)

    // D13: these three queries only depend on chatIds (already resolved) and
    // are independent of each other — run them concurrently instead of three
    // sequential DB round-trips.
    const [memberRows, lastActivityRows, unreadRows] = await Promise.all([
      chatIds.length === 0
        ? Promise.resolve([] as { chatId: string; userId: string }[])
        : db
            .select({
              chatId: chatMembers.chatId,
              userId: chatMembers.userId,
            })
            .from(chatMembers)
            .where(inArray(chatMembers.chatId, chatIds)),
      chatIds.length === 0
        ? Promise.resolve([] as { chatId: string; lastAt: unknown }[])
        : db
            .select({
              chatId: messages.chatId,
              lastAt: max(messages.createdAt),
            })
            .from(messages)
            .where(inArray(messages.chatId, chatIds))
            .groupBy(messages.chatId),
      directChatIds.length === 0
        ? Promise.resolve([] as { chatId: string; cnt: number }[])
        : db
            .select({
              chatId: messages.chatId,
              cnt: count(),
            })
            .from(messages)
            .where(
              and(
                inArray(messages.chatId, directChatIds),
                isNull(messages.readAt),
                ne(messages.senderId, user.id)
              )
            )
            .groupBy(messages.chatId)
            // non-fatal: unread counts fall back to 0
            .catch(() => [] as { chatId: string; cnt: number }[]),
    ])

    const memberMap = new Map<string, string[]>()
    for (const m of memberRows) {
      const list = memberMap.get(m.chatId) ?? []
      list.push(m.userId)
      memberMap.set(m.chatId, list)
    }

    const lastMessageAtByChat = new Map<string, string | null>()
    for (const r of lastActivityRows) {
      const t = r.lastAt
      lastMessageAtByChat.set(
        r.chatId,
        t instanceof Date ? t.toISOString() : t != null ? String(t) : null
      )
    }

    const unreadCountByChat = new Map<string, number>()
    for (const r of unreadRows) {
      unreadCountByChat.set(r.chatId, r.cnt)
    }

    return reply.send({
      chats: rows.map((c) => {
        const isGroup = isGroupType(c.type)
        const memberIds = memberMap.get(c.id) ?? []
        // A genuine self-chat ("Saved Messages") is created with exactly one
        // member and that hardcoded name. A direct DM whose peer self-deleted
        // also collapses to a single member (the cascade drops the peer's
        // membership) — without the name guard that orphaned remnant would
        // masquerade as the viewer's own Saved Messages and intermix with it.
        const isSelf =
          !isGroup &&
          c.type === 'direct_e2e' &&
          memberIds.length === 1 &&
          memberIds[0] === user.id &&
          c.name === 'Saved Messages'
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
          my_channel_role: c.myChannelRole ?? null,
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

  app.post('/:chatId/favorite', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

  app.delete('/:chatId/favorite', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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
  app.patch('/:chatId/mute', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

  app.post('/join/:code', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
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

    if (!chat || (chat.type !== 'group_e2e' && chat.type !== 'public_open' && chat.type !== 'channel')) {
      return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
    }

    // Did we match the (consumable) invite CODE or the permanent SLUG? One-time
    // consumption only applies to a code join.
    const viaCode = chat.inviteCode != null && chat.inviteCode === trimmed

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
      // Atomically consume a one-time CODE before admitting anyone: the guarded
      // conditional UPDATE (WHERE invite_code = trimmed) lets exactly one
      // concurrent joiner win — the rest see 0 rows cleared and are rejected,
      // closing the race where two joiners both passed the stale pre-tx check.
      if (chat.inviteOneTime && viaCode) {
        const cleared = await tx
          .update(chats)
          .set({ inviteCode: null })
          .where(and(eq(chats.id, chat.id), eq(chats.inviteCode, trimmed)))
          .returning({ id: chats.id })
        if (cleared.length === 0) {
          return { kind: 'consumed' as const }
        }
      }

      const inserted = await tx
        .insert(chatMembers)
        .values({
          chatId: chat.id,
          userId: user.id,
          encryptedGroupKey: null,
          role: 'member',
          // Joining a channel via invite link -> subscriber by default
          ...(chat.type === 'channel' ? { channelRole: 'subscriber' as const } : {}),
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

      return { kind: 'joined' as const }
    })

    if (outcome.kind === 'consumed') {
      // Lost the one-time-code race to a concurrent joiner.
      return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
    }

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
    if ((type === 'public_open' || type === 'channel') && uniqueIds.length < 1) {
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
    const isChannel = type === 'channel'
    const inviteCode = (isPublicOpen || isChannel) ? await generateUniqueInviteCode() : null

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
          role: (isPublicOpen || isChannel) && uid === authId ? ('owner' as const) : ('member' as const),
          // Channel: creator is owner, everyone else is subscriber
          ...(isChannel ? { channelRole: uid === authId ? ('owner' as const) : ('subscriber' as const) } : {}),
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

  app.post('/:chatId/invite', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

  app.patch('/:chatId/invite-slug', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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
    } catch (e: unknown) {
      // Only a unique-constraint violation means the slug is taken; surface other
      // (transient/infra) errors instead of masking them as "slug taken".
      if ((e as { code?: string }).code === '23505') {
        return reply.status(409).send({ error: 'INVITE_SLUG_TAKEN' })
      }
      throw e
    }

    return reply.send({ invite_slug: nextSlug })
  })

  app.post('/:chatId/leave', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

    if ((chat.type === 'group_e2e' || chat.type === 'public_open' || chat.type === 'channel') && myRow.role === 'owner') {
      // Owner leaving a chat that has other members: hand ownership to the next
      // member, remove ourselves, and (for SECTOR chats) bump the key epoch —
      // ALL in one transaction. Selecting + promoting the nominee inside the txn
      // and verifying the promote affected a row closes a race where a
      // simultaneous departure of the nominee would otherwise leave the chat
      // ownerless (a 0-row UPDATE the old code never noticed). If every candidate
      // vanishes we fall through to the plain-leave path below (which deletes the
      // chat when we turn out to be the last member).
      let transferred = false
      let newKeyEpoch: number | null = null
      let notifyIds: string[] = []
      await db.transaction(async (tx) => {
        const others = await tx
          .select({
            userId: chatMembers.userId,
            role: chatMembers.role,
            joinedAt: chatMembers.joinedAt,
          })
          .from(chatMembers)
          .where(
            and(eq(chatMembers.chatId, chatId), ne(chatMembers.userId, user.id))
          )
        if (others.length === 0) return

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

        // Promote the first candidate that still exists. A 0-row update means
        // that member departed concurrently — try the next candidate.
        // Channels track a separate channelRole; the successor must also become
        // channelRole 'owner' or they can't post to / manage the channel. (The
        // race-safe nominee selection + transaction are unchanged.)
        const promoteSet =
          chat.type === 'channel'
            ? ({ role: 'owner', channelRole: 'owner' } as const)
            : ({ role: 'owner' } as const)
        let promotedId: string | null = null
        for (const cand of sorted) {
          const promoted = await tx
            .update(chatMembers)
            .set(promoteSet)
            .where(
              and(
                eq(chatMembers.chatId, chatId),
                eq(chatMembers.userId, cand.userId)
              )
            )
            .returning({ userId: chatMembers.userId })
          if (promoted.length) {
            promotedId = cand.userId
            break
          }
        }
        if (!promotedId) return // every other member vanished too → fall through

        await tx
          .delete(chatMembers)
          .where(
            and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
          )

        const remaining = await tx
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))
        notifyIds = [...remaining.map((r) => r.userId), user.id]

        if (chat.type === 'group_e2e') {
          const bumped = await tx
            .update(chats)
            .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
            .where(eq(chats.id, chatId))
            .returning({ keyEpoch: chats.keyEpoch })
          newKeyEpoch = bumped[0]?.keyEpoch ?? null
        }
        transferred = true
      })

      if (transferred) {
        broadcastToUsers(notifyIds, { type: 'chats_updated' })
        broadcastKeyEpoch(chatId, newKeyEpoch, notifyIds)
        return reply.send({ ok: true })
      }
      // else: no eligible next owner — fall through to the plain-leave path.
    }

    // Non-owner leave (or owner who turned out to be the last member). Remove
    // ourselves and, in the same transaction, either delete the now-empty chat
    // or bump the SECTOR key epoch — so the epoch can never lag the membership.
    let wasMember = false
    let chatDeleted = false
    let newKeyEpoch: number | null = null
    let remaining: { userId: string }[] = []
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(chatMembers)
        .where(
          and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
        )
        .returning({ chatId: chatMembers.chatId })
      if (!deleted.length) return
      wasMember = true

      remaining = await tx
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))

      if (remaining.length === 0) {
        await tx.delete(messages).where(eq(messages.chatId, chatId))
        await tx.delete(chats).where(eq(chats.id, chatId))
        chatDeleted = true
      } else if (chat.type === 'group_e2e') {
        const bumped = await tx
          .update(chats)
          .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
          .where(eq(chats.id, chatId))
          .returning({ keyEpoch: chats.keyEpoch })
        newKeyEpoch = bumped[0]?.keyEpoch ?? null
      }
    })

    if (!wasMember) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }
    if (!chatDeleted) {
      const notifyIds = [...remaining.map((r) => r.userId), user.id]
      broadcastToUsers(notifyIds, { type: 'chats_updated' })
      broadcastKeyEpoch(chatId, newKeyEpoch, notifyIds)
    }

    return reply.send({ ok: true })
  })

  app.patch('/:chatId/members/:userId/role', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

  app.delete('/:chatId/members/:userId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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

    // Remove the member and bump the SECTOR key epoch in one transaction so the
    // epoch can never lag the membership state across a crash.
    let newKeyEpoch: number | null = null
    await db.transaction(async (tx) => {
      await tx
        .delete(chatMembers)
        .where(
          and(
            eq(chatMembers.chatId, chatId),
            eq(chatMembers.userId, targetUserId)
          )
        )
      if (chat.type === 'group_e2e') {
        const bumped = await tx
          .update(chats)
          .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
          .where(eq(chats.id, chatId))
          .returning({ keyEpoch: chats.keyEpoch })
        newKeyEpoch = bumped[0]?.keyEpoch ?? null
      }
    })

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)

    const notifyIds = [...memberIds, targetUserId]
    broadcastToUsers(notifyIds, { type: 'chats_updated' })
    broadcastKeyEpoch(chatId, newKeyEpoch, notifyIds)
    return reply.send({ ok: true })
  })

  app.put('/:chatId/members/:userId/wrapped-key', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
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

    const actorRole = await getMemberRole(chatId, user.id)
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    // Self-target is permitted: on a key rotation the owner must persist its OWN
    // freshly-minted wrapped key (the client rebuilds the SECTOR context from the
    // server, so the owner would otherwise lose the new key on next chat open).
    // Authz already restricts writes to owner/admin above.

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

  app.delete('/:chatId', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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

    // Gather attachment keys before the DB cascade so we can free the
    // S3 objects (DB rows cascade, but blobs would otherwise linger
    // until the next retention sweep).
    await scheduleMediaCleanupForChat(chatId)

    // Atomic teardown: a crash between these statements used to leave a
    // half-deleted chat (messages gone but chat/members orphaned, or vice
    // versa). One transaction makes it all-or-nothing.
    await db.transaction(async (tx) => {
      await tx.delete(messages).where(eq(messages.chatId, chatId))
      await tx.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
      await tx.delete(chats).where(eq(chats.id, chatId))
    })

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
        // Current key-rotation generation. The client compares this against the
        // epoch stamped in its stored wrapped key to detect a stale key after a
        // membership change and (owner only) mint a fresh one.
        key_epoch: chat.keyEpoch,
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
        inviteOneTime: chats.inviteOneTime,
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
        // Never expose a CONSUMABLE one-time invite code to strangers browsing
        // discovery — anyone could read and burn an owner's single-use invite,
        // denying it to the intended recipient. The stable slug is a safe public
        // join handle (joining by slug doesn't consume the one-time code).
        invite_code: r.inviteOneTime ? null : r.inviteCode,
        invite_slug: r.inviteSlug,
        member_count: Number(r.memberCount ?? 0),
      }))
    )
  })
}

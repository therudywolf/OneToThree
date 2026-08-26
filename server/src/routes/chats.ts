import { randomBytes, randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { and, asc, count, desc, eq, ilike, inArray, isNull, max, ne, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db, type Db } from '../db/index.js'
import {
  chatFavorites,
  chatMembers,
  chats,
  guestInvites,
  messages,
  userBlocks,
  users,
} from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  getChatById,
  getMemberRole,
  type ChatMemberRole,
} from '../lib/chat-permissions.js'
import { broadcastToUsers } from '../ws/registry.js'
import { isUserInRoom, leaveRoom } from '../ws/group-call-rooms.js'
import { getRedis } from '../lib/redis.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import {
  collectChatMediaTargets,
  deleteCollectedMediaTargets,
  scheduleMediaCleanupForChat,
} from '../lib/media-cleanup.js'
import {
  createS3Client,
  createS3ClientForPresigning,
  deleteObjectIfExists,
  ensureBucketExists,
  getAvatarsBucketName,
  presignPutObject,
  rewritePresignedUrlToPublicBase,
} from '../lib/s3.js'

const patchRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
})

const wrappedKeySchema = z.object({
  encrypted_group_key: z.string().min(1),
  /**
   * Set by the FIRST write of a rotation to atomically claim the epoch it is
   * rotating away from. See the CAS in the handler — this is what stops two
   * owner sessions from both minting a key at the same epoch.
   */
  claim_from_epoch: z.number().int().min(0).optional(),
})

const invitePostSchema = z.object({
  invite_one_time: z.boolean().optional(),
})
const inviteSlugPatchSchema = z.object({
  invite_slug: z.string().trim().min(4).max(32).regex(/^[a-z0-9_]+$/),
})

// 'owner' is deliberately not accepted here: channel ownership moves only via
// the ownership transfer in PATCH .../role, which updates role AND
// channel_role together so the two columns can never disagree about who owns
// the feed.
const patchChannelRoleSchema = z.object({
  channel_role: z.enum(['subscriber', 'editor']),
})

const patchDiscussionSchema = z.object({
  discussion_chat_id: uuidSchema.nullable(),
})

/**
 * Presentation + publicity of a group-kind chat. Every field is optional; an
 * empty object is rejected so a no-op PATCH cannot masquerade as a change.
 * `name` keeps the 256 cap used at creation.
 */
const patchChatMetaSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    description: z.string().max(1024).nullable().optional(),
    is_public: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'NOTHING_TO_UPDATE' })

/**
 * Upper bound on the member list accepted at creation. Unbounded arrays turned
 * one request into thousands of `users`/`user_blocks` lookups (and, past ~65k
 * entries, blew the driver's bind-parameter limit into a 500). Growing a chat
 * beyond this goes through invites, one member at a time.
 */
const MAX_CHAT_MEMBERS = 256

const createChatSchema = z
  .object({
    type: z.enum(['direct_e2e', 'group_e2e', 'public_open', 'channel']),
    name: z.string().max(256).optional().nullable(),
    member_ids: z.array(uuidSchema).max(MAX_CHAT_MEMBERS).optional(),
    members: z
      .array(
        z.object({
          userId: uuidSchema,
          encryptedGroupKey: z.string().min(1),
        })
      )
      .max(MAX_CHAT_MEMBERS)
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

/**
 * True if a block exists between `meId` and ANY of `otherIds`.
 *
 * One set query instead of a sequential `isBlocked()` round-trip per member:
 * the loop held a pool connection for its whole walk, so a single create-chat
 * call with a large member list could pin connections for seconds.
 */
async function anyBlockBetween(meId: string, otherIds: string[]): Promise<boolean> {
  const targets = otherIds.filter((id) => id !== meId)
  if (targets.length === 0) return false
  const [hit] = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, meId), inArray(userBlocks.blockedId, targets)),
        and(eq(userBlocks.blockedId, meId), inArray(userBlocks.blockerId, targets))
      )
    )
    .limit(1)
  return Boolean(hit)
}

/**
 * Evict a departing member from this chat's group-call room.
 *
 * Group-call membership lives in Redis (`group-call:room:{chatId}`, 8h TTL) and
 * is authorized ONCE, at join: every later media/signaling frame only checks
 * `isUserInRoom`. So a kicked — or self-removed — member kept sending and
 * hearing call audio for up to the room TTL, silently defeating the key-epoch
 * bump that is supposed to cut them off. Mirrors the WS gcLeave cleanup,
 * including the per-call session-key rotation once the room empties.
 */
async function evictFromGroupCall(chatId: string, userId: string): Promise<void> {
  // Cheap HEXISTS guard: departures vastly outnumber calls, and without it every
  // kick/leave would broadcast a bogus group_call:ended for a room that was
  // never active (leaveRoom on an empty room returns "no participants left").
  if (!(await isUserInRoom(chatId, userId))) return

  const remaining = await leaveRoom(chatId, userId)
  broadcastToUsers([...remaining.map((p) => p.userId), userId], {
    type: 'group_call:member_leave',
    room_id: chatId,
    user_id: userId,
  })
  if (remaining.length > 0) return

  const redis = getRedis()
  if (redis) {
    try {
      await redis.del(`call:session:${chatId}`)
    } catch {
      /* best-effort */
    }
  }
  const memberIds = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
  broadcastToUsers(
    memberIds.map((r) => r.userId),
    { type: 'group_call:ended', room_id: chatId }
  )
}

/**
 * Revoke the guest links a departing member made for THIS chat.
 *
 * A guest link outlived the membership that authorized it: nothing re-checked
 * the creator after POST /guest-invites, so an ex-member's link kept minting
 * LiveKit tokens for the chat's room — with the very media key the remaining
 * members hold — and the group's owner had no way to kill it (DELETE
 * /guest-invites/:id is scoped to the creator). Their own call token is already
 * refused; the links they can still hand out must go the same way.
 *
 * Only when guest mode is on: with FEATURE_GUESTS off no such link can be
 * created or redeemed, and the table need not exist in that deployment.
 */
async function revokeGuestInvitesFor(
  chatId: string,
  userId: string,
  guestsEnabled: boolean
): Promise<void> {
  if (!guestsEnabled) return
  await db
    .update(guestInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(guestInvites.chatId, chatId),
        eq(guestInvites.createdBy, userId),
        isNull(guestInvites.revokedAt)
      )
    )
}

/**
 * If a direct_e2e chat already links exactly these two users, return it
 * (idempotent create). `exec` lets the caller run the lookup INSIDE the
 * transaction that holds the pair's advisory lock — see POST /.
 */
export async function findExistingDirectE2EBetween(
  userA: string,
  userB: string,
  exec: Db = db
): Promise<{ id: string; name: string | null; type: string } | null> {
  const rows = await exec
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

/** Single-query self-chat lookup. `exec` may be a transaction (see below). */
async function findSelfChat(userId: string, exec: Db = db) {
  // Pick direct_e2e chats where the user is a member AND the chat has exactly
  // one member total (i.e. just the user). Replaces the previous N+1 loop (one
  // members-query per direct chat).
  const selfChats = await exec
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
  return selfChats[0] ?? null
}

/** Find or create a self-chat (Saved Messages) for the given user. Returns the chat row. */
async function getOrCreateSelfChat(userId: string) {
  const existing = await findSelfChat(userId)
  if (existing) {
    return { chat: existing, created: false }
  }

  // Check-then-insert with nothing to serialize it: two tabs bootstrapping at
  // once both saw "no self chat" and both inserted, leaving TWO "Saved
  // Messages" chats — after which the .limit(1) lookup picks one arbitrarily
  // and saved notes appear to vanish. Re-check under a txn-scoped advisory
  // lock keyed on the user (same technique as the poll-vote lock in polls.ts):
  // the loser blocks until the winner commits, then finds the winner's chat.
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`self_chat:${userId}`}))`)
    const raced = await findSelfChat(userId, txDb)
    if (raced) return { chat: raced, created: false }

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
    return { chat, created: true }
  })
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
  avatarKey: string | null
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
      avatarKey: chats.avatarKey,
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
    avatarKey: r.avatarKey,
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
  // Chat avatars live in the same bucket and key shape as user avatars
  // (`avatars/{uuid}/{uuid}.jpg`), so the existing AVATAR_KEY_RE and the
  // presigned-GET route keep working unchanged.
  const s3 = createS3Client()
  const presignS3 = createS3ClientForPresigning()
  /** Presigned chat-avatar PUTs awaiting their commit, keyed by chat. */
  const pendingChatAvatars = new Map<string, { key: string; exp: number }>()
  const CHAT_AVATAR_TTL_MS = 15 * 60 * 1000
  const MAX_CHAT_AVATAR_BYTES = 2 * 1024 * 1024

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
          avatar_key: c.avatarKey,
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

      // #32 backward secrecy: bump the key epoch on a group_e2e join, in the
      // SAME transaction as the membership insert (so the epoch can never lag
      // the roster across a crash — mirrors the departure-side bump). The
      // owner's rekey then stamps a fresh epoch and the joiner receives ONLY
      // that new key; every pre-join epoch was sealed to the other members and
      // was never on the server for the newcomer, so its history stays sealed.
      let newKeyEpoch: number | null = null
      if (chat.type === 'group_e2e') {
        const bumped = await tx
          .update(chats)
          .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
          .where(eq(chats.id, chat.id))
          .returning({ keyEpoch: chats.keyEpoch })
        newKeyEpoch = bumped[0]?.keyEpoch ?? null
      }

      return { kind: 'joined' as const, newKeyEpoch }
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
      // …and announce the bumped epoch so the OWNER rekeys to the new epoch and
      // hands the joiner the fresh key (backward secrecy, #32). Broadcast to all
      // members: rotation is owner-only client-side, so it's a no-op for the rest.
      broadcastKeyEpoch(chat.id, outcome.newKeyEpoch, memberIds)
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
      if (await anyBlockBetween(user.id, uniqueIds)) {
        return reply.status(403).send({ error: 'BLOCKED' })
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
      // NOTE (#28): requester-supplied member_ids for public_open/channel are
      // added directly here. A blanket "creator only" restriction was tried but
      // reverted — it broke the legitimate "create a channel/group and seed it
      // with initial members/admins" flow (see chats-ops.test.ts channel
      // ownership transfer). The harassment concern (force-listing strangers)
      // is marginal in an app that already permits messaging any user by UUID,
      // and the block relationship is already enforced below. Closing it
      // properly needs an invite/accept (consent) step — a feature, deferred.
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
    if (await anyBlockBetween(authId, uniqueIds)) {
      return reply.status(403).send({ error: 'BLOCKED' })
    }

    if (type === 'direct_e2e') {
      const peerId = uniqueIds.find((id) => id !== authId)
      if (peerId) {
        // Check-then-insert with nothing serializing it: A tapping "Message" on
        // B while B taps "Message" on A (or one client retrying a timed-out
        // POST) had both requests see "no chat" and create one each — two DMs
        // with the same peer, each holding half of the conversation, with
        // findExistingDirectE2EBetween's .limit(1) then picking between them
        // arbitrarily on every later lookup. Re-check and insert under a
        // txn-scoped advisory lock on the sorted uuid pair (same technique as
        // the poll-vote lock in polls.ts): the loser blocks until the winner
        // commits and then finds the winner's chat.
        const [lo, hi] = [authId, peerId].sort()
        let createdDirect = false
        const direct = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`direct_chat:${lo}:${hi}`}))`
          )
          const raced = await findExistingDirectE2EBetween(authId, peerId, txDb)
          if (raced) return raced

          const inserted = await tx
            .insert(chats)
            .values({ type: 'direct_e2e', name: name ?? null })
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
          createdDirect = true
          return { id: chat.id, name: chat.name, type: chat.type }
        })

        if (createdDirect) broadcastToUsers(uniqueIds, { type: 'chats_updated' })

        return reply.status(201).send({
          chat: {
            id: direct.id,
            name: direct.name,
            type: direct.type,
            is_group: false,
            member_ids: uniqueIds,
            my_role: 'member' as const,
          },
        })
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

    // No local `code` to carry out of the loop: the handler re-reads the row
    // below and answers with THAT, so anything assigned here was a dead store.
    if (!chat.inviteCode) {
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
        if (updated.length > 0) break
        // Another request beat us; stop once a code exists either way.
        const [existing] = await db
          .select({ inviteCode: chats.inviteCode })
          .from(chats)
          .where(eq(chats.id, chatId))
          .limit(1)
        if (existing?.inviteCode) break
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
        await evictFromGroupCall(chatId, user.id)
        await revokeGuestInvitesFor(chatId, user.id, request.server.featureFlags.guests)
        broadcastToUsers(notifyIds, { type: 'chats_updated' })
        broadcastKeyEpoch(chatId, newKeyEpoch, notifyIds)
        return reply.send({ ok: true })
      }
      // else: no eligible next owner — fall through to the plain-leave path.
    }

    // Last member out tears the chat down below — and that teardown is what
    // makes the S3 objects unreclaimable: both sweeps are DB-driven (they scan
    // `messages.media_path` and `attachments`), so once those rows are gone
    // nothing can ever enumerate the keys again and the blobs sit in MinIO
    // forever. Gather them first, exactly as DELETE /:chatId does.
    // COLLECT only. Whether the chat actually dies is decided by the
    // transaction below, and these two reads are not serialized with each other:
    // deleting here meant that if someone redeemed the invite link in the
    // millisecond between them, the chat and its full message history survived
    // with every media blob already wiped — and with no `evicted_at` stamped, so
    // /storage/download-url kept handing out presigned URLs to keys that no
    // longer exist (a raw MinIO 404 instead of the MEDIA_EVICTED placeholder the
    // client knows how to render). The keys must still be gathered BEFORE the
    // rows are deleted: both sweeps are DB-driven, so once the rows are gone
    // nothing can enumerate the blobs again.
    const mediaTargets = await collectChatMediaTargets(chatId)

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
    // Only now, once the transaction has committed the decision, is it safe to
    // wipe the blobs — and only on the branch that actually dropped the chat.
    if (chatDeleted) {
      deleteCollectedMediaTargets(mediaTargets)
    }
    // Membership is gone — so must be the seat in the group call (see evictFromGroupCall).
    await evictFromGroupCall(chatId, user.id)
    await revokeGuestInvitesFor(chatId, user.id, request.server.featureFlags.guests)
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
      // Channels gate posting/pinning by the SEPARATE channel_role column, so an
      // ownership transfer that only moves `role` would leave the new owner as a
      // channel 'subscriber' (CHANNEL_SUBSCRIBERS_CANNOT_POST) and the old owner
      // still channel 'owner'. Move channel_role too: new owner -> 'owner',
      // demoted owner -> 'editor' (retains post rights, matching their new admin
      // role) — mirroring the owner-leaves successor path above.
      const isChannel = chat.type === 'channel'
      await db.transaction(async (tx) => {
        await tx
          .update(chatMembers)
          .set(isChannel ? { role: 'admin', channelRole: 'editor' } : { role: 'admin' })
          .where(
            and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
          )
        await tx
          .update(chatMembers)
          .set(isChannel ? { role: 'owner', channelRole: 'owner' } : { role: 'owner' })
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

  /**
   * Rename / describe / (un)list a group-kind chat.
   *
   * Owner-only, deliberately: `name`, `description` and the catalog switch are
   * how the room presents itself to strangers, which is the owner's call rather
   * than any admin's. Members below owner keep every existing power (invites,
   * kicks, roles) — this only adds the presentation surface that did not exist
   * at all before, when `name` was write-once at creation.
   */
  app.patch('/:chatId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const parsed = patchChatMetaSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const chat = await getChatById(chatId)
    if (!chat || !isGroupType(chat.type)) {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    if (!actorRole) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }
    if (actorRole !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const updates: Partial<{ name: string; description: string | null; isPublic: boolean }> = {}
    if (parsed.data.name !== undefined) updates.name = parsed.data.name
    if (parsed.data.description !== undefined) {
      // Empty string clears the description rather than storing a blank line.
      updates.description = parsed.data.description?.trim() ? parsed.data.description.trim() : null
    }
    if (parsed.data.is_public !== undefined) updates.isPublic = parsed.data.is_public

    const [after] = await db
      .update(chats)
      .set(updates)
      .where(eq(chats.id, chatId))
      .returning({
        name: chats.name,
        description: chats.description,
        isPublic: chats.isPublic,
        avatarKey: chats.avatarKey,
      })

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)
    broadcastToUsers(memberIds, { type: 'chats_updated' })

    return reply.send({
      ok: true,
      name: after?.name ?? null,
      description: after?.description ?? null,
      is_public: after?.isPublic ?? true,
      avatar_key: after?.avatarKey ?? null,
    })
  })

  /**
   * Chat avatar upload, owner-only.
   *
   * Unlike the user-avatar presign this does NOT demand a vault signature. That
   * proof exists because a profile picture is an identity claim, and a stolen
   * session must not be able to repaint someone's face. A chat avatar is plain
   * room decoration that the same session could already change by other means
   * (it can rename the room through PATCH /chats/:id, or simply post), so a
   * vault prompt here would buy nothing and cost an unlock on every edit. The
   * anti-abuse property that DOES matter — a write capability into a bucket no
   * quota counts — is preserved by the tight per-hour cap below.
   */
  app.post('/:chatId/avatar/presign', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const chat = await getChatById(chatId)
    if (!chat || !isGroupType(chat.type)) {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }
    if ((await getMemberRole(chatId, user.id)) !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const bucket = getAvatarsBucketName()
    await ensureBucketExists(s3, bucket)

    const key = `avatars/${chatId}/${randomUUID()}.jpg`
    const uploadUrl = rewritePresignedUrlToPublicBase(
      await presignPutObject({
        client: presignS3,
        bucket,
        key,
        contentType: 'image/jpeg',
      })
    )
    pendingChatAvatars.set(chatId, { key, exp: Date.now() + CHAT_AVATAR_TTL_MS })

    return reply.send({ uploadUrl, avatar_key: key })
  })

  app.post('/:chatId/avatar/commit', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const parsed = z.object({ avatar_key: z.string().min(1).max(512) }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const avatarKey = parsed.data.avatar_key

    const chat = await getChatById(chatId)
    if (!chat || !isGroupType(chat.type)) {
      return reply.status(400).send({ error: 'NOT_GROUP_CHAT' })
    }
    if ((await getMemberRole(chatId, user.id)) !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    // The key must be the one WE handed out for THIS chat — never a
    // caller-chosen path, which would let an owner point their room at (or
    // overwrite) another chat's or a user's avatar object.
    const pending = pendingChatAvatars.get(chatId)
    pendingChatAvatars.delete(chatId)
    if (!pending || pending.exp < Date.now() || pending.key !== avatarKey) {
      return reply.status(400).send({ error: 'NO_PENDING_AVATAR' })
    }

    const bucket = getAvatarsBucketName()
    await ensureBucketExists(s3, bucket)

    let uploadedBytes: number
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: avatarKey }))
      uploadedBytes = Number(head.ContentLength ?? 0)
    } catch {
      return reply.status(412).send({ error: 'AVATAR_OBJECT_MISSING' })
    }
    if (uploadedBytes > MAX_CHAT_AVATAR_BYTES) {
      await deleteObjectIfExists({ client: s3, bucket, key: avatarKey })
      return reply.status(413).send({ error: 'AVATAR_TOO_LARGE', max_bytes: MAX_CHAT_AVATAR_BYTES })
    }

    if (chat.avatarKey && chat.avatarKey !== avatarKey) {
      await deleteObjectIfExists({ client: s3, bucket, key: chat.avatarKey })
    }
    await db.update(chats).set({ avatarKey }).where(eq(chats.id, chatId))

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)
    broadcastToUsers(memberIds, { type: 'chats_updated' })

    return reply.send({ ok: true, avatar_key: avatarKey })
  })

  // The "posting mode" buttons in channel settings apply one PATCH per member,
  // so this limit must absorb a full-member sweep, not just single clicks.
  app.patch('/:chatId/members/:userId/channel-role', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema, userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId, userId: targetUserId } = params.data

    const parsed = patchChannelRoleSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'channel') {
      return reply.status(400).send({ error: 'NOT_CHANNEL_CHAT' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    const targetRole = await getMemberRole(chatId, targetUserId)
    if (!actorRole || !targetRole) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }
    if (actorRole !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }
    if (targetUserId === user.id) {
      return reply.status(400).send({ error: 'CANNOT_PATCH_SELF' })
    }

    await db
      .update(chatMembers)
      .set({ channelRole: parsed.data.channel_role })
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
  })

  app.patch('/:chatId/discussion', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const parsed = patchDiscussionSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const discussionChatId = parsed.data.discussion_chat_id

    const chat = await getChatById(chatId)
    if (!chat || chat.type !== 'channel') {
      return reply.status(400).send({ error: 'NOT_CHANNEL_CHAT' })
    }

    const actorRole = await getMemberRole(chatId, user.id)
    if (!actorRole) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }
    if (actorRole !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    if (discussionChatId !== null) {
      if (discussionChatId === chatId) {
        return reply.status(400).send({ error: 'DISCUSSION_SELF' })
      }
      const target = await getChatById(discussionChatId)
      if (!target || (target.type !== 'group_e2e' && target.type !== 'public_open')) {
        return reply.status(400).send({ error: 'DISCUSSION_NOT_GROUP' })
      }
      // The owner must be inside the discussion room: linking a foreign chat
      // would point subscribers at a room the owner can't even see, and leak
      // that the room exists.
      const targetMembership = await getMemberRole(discussionChatId, user.id)
      if (!targetMembership) {
        return reply.status(403).send({ error: 'DISCUSSION_NOT_MEMBER' })
      }
    }

    await db
      .update(chats)
      .set({ discussionChatId })
      .where(eq(chats.id, chatId))

    const memberIds = (
      await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
    ).map((r) => r.userId)
    broadcastToUsers(memberIds, { type: 'chats_updated' })
    return reply.send({ ok: true })
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

    // The epoch bump above only cuts the kicked member out of MESSAGE traffic;
    // the call channel needs its own eviction (see evictFromGroupCall) — and
    // the guest links they made for this chat are a third door out of the same
    // room (see revokeGuestInvitesFor).
    await evictFromGroupCall(chatId, targetUserId)
    await revokeGuestInvitesFor(chatId, targetUserId, request.server.featureFlags.guests)

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

    // OWNER-ONLY (D2). The SECTOR group-key wrap a member adopts is bound
    // client-side to the OWNER's ECDH identity (see chat-crypto.ts /
    // unwrapGroupKeyFromStoredPayload). Only the owner can produce a wrap that
    // ECDH-derives under their key, so admins can no longer write group-key
    // rows: an admin write could only ever store a key the recipient would
    // reject — and permitting it reopened the group-MITM hole (an admin or the
    // server overwriting a victim's wrap with an attacker key). The owner is the
    // single rotator by design (see group-key-rotation.ts), so this matches the
    // only legitimate writer.
    const actorRole = await getMemberRole(chatId, user.id)
    if (actorRole !== 'owner') {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    // Self-target is permitted: on a key rotation the owner must persist its OWN
    // freshly-minted wrapped key (the client rebuilds the SECTOR context from the
    // server, so the owner would otherwise lose the new key on next chat open).
    // Authz already restricts writes to the owner above.

    const targetOk = await getMemberRole(chatId, targetUserId)
    if (!targetOk) {
      return reply.status(404).send({ error: 'NOT_A_MEMBER' })
    }

    // COMPARE-AND-SWAP on the epoch, when the caller is starting a rotation.
    //
    // Nothing serialized rotations before this. Two sessions of the same owner
    // (phone + laptop, or two tabs) could each observe epoch N, each mint a
    // DIFFERENT group key, and each write wrapped keys for every member — so
    // members ended up split across two keys under one epoch number and simply
    // could not read each other. It never self-healed either: the epoch matched
    // everywhere, so every "is my key stale?" check said no.
    //
    // The conditional bump is the serialization point. Exactly one rotation can
    // move the chat off epoch N; the loser is told to re-read and try again
    // rather than scattering a second key across the roster.
    let claimedEpoch: number | null = null
    if (parsed.data.claim_from_epoch !== undefined) {
      const bumped = await db
        .update(chats)
        .set({ keyEpoch: sql`${chats.keyEpoch} + 1` })
        .where(and(eq(chats.id, chatId), eq(chats.keyEpoch, parsed.data.claim_from_epoch)))
        .returning({ keyEpoch: chats.keyEpoch })
      if (!bumped.length) {
        return reply.status(409).send({ error: 'KEY_EPOCH_STALE' })
      }
      claimedEpoch = bumped[0]?.keyEpoch ?? null
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
    if (claimedEpoch != null) {
      const memberRows = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
      broadcastKeyEpoch(chatId, claimedEpoch, memberRows.map((r) => r.userId))
    }
    return reply.send({ ok: true, key_epoch: claimedEpoch })
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

    // direct_e2e has no owner, so the gate above lets EITHER participant here —
    // and this endpoint used to hard-delete every message in the chat, wiping
    // the peer's whole history (including everything THEY sent) on demand. That
    // contradicts DELETE /messages/:messageId, which refuses a non-sender even
    // for one message, and the button is only labelled 'Delete History'. Make
    // it per-user, exactly like POST /:chatId/leave: drop our own membership and
    // only tear the chat down once nobody is left (which still covers Saved
    // Messages, a one-member direct chat).
    if (!isGroupType(chat.type) && allMembers.some((m) => m.userId !== user.id)) {
      await db
        .delete(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
      await evictFromGroupCall(chatId, user.id)
      broadcastToUsers(
        allMembers.map((m) => m.userId),
        { type: 'chats_updated' }
      )
      return reply.send({ ok: true })
    }

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
        channelRole: chatMembers.channelRole,
        userGroup: users.userGroup,
        displayName: users.displayName,
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
        discussion_chat_id: chat.discussionChatId ?? null,
        description: chat.description ?? null,
        avatar_key: chat.avatarKey ?? null,
        is_public: chat.isPublic,
      },
      members: members.map((m) => ({
        user_id: m.userId,
        username: m.username,
        ecdh_public_key_jwk: m.ecdhPublicKeyJwk,
        avatar_key: m.avatarKey,
        encrypted_group_key: m.encryptedGroupKey,
        role: m.role,
        channel_role: m.channelRole,
        // Server-assigned tier: `'guest'` marks a link-invited temp-chat guest.
        // Clients use it for the guest badge AND to allow the v1 fan-out
        // exception in DIRECT decrypt (guests cannot run the Double Ratchet) —
        // it must come from the server, a `guest_`-looking username is not
        // proof (and registering such handles is refused anyway).
        user_group: m.userGroup,
        display_name: m.displayName,
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
      // Owners can unlist a room without giving up its invite link; an unlisted
      // chat stays fully joinable by code/slug, it just leaves the catalog.
      eq(chats.isPublic, true),
      q ? ilike(chats.name, `%${q}%`) : undefined
    )

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        type: chats.type,
        description: chats.description,
        avatarKey: chats.avatarKey,
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
        description: r.description,
        avatar_key: r.avatarKey,
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

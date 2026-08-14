// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// One-time guest links (docs/project/GUEST_MODE_CONCEPT.ru.md).
// ---------------------------------------------------------------------------
// Mechanism A — call guest ("bodiless"): resolve → knock → creator approves →
//   the guest's poll picks up a LiveKit grant. No users row, no cookie, no WS;
//   the guest's entire server surface is the four public endpoints below.
// Mechanism B — temp chat guest: enter consumes the link, creates an ephemeral
//   `users` row (group 'guest') + a direct_e2e chat with the creator; the
//   guest then logs in through the NORMAL /auth/challenge + /auth/verify with
//   an in-tab keypair. Everything outside GUEST_ALLOWED_ROUTES (app.ts) 403s.
//
// This whole route group is registered ONLY when FEATURE_GUESTS=1 — when the
// flag is off none of these paths exist (404), matching the Lite gating
// pattern for calls/stickers/push/admin.
// ---------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, chats, guestInvites, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import { getCallMediaMode } from '../lib/call-media-mode.js'
import { resolveCallTokenTtlSeconds } from './call.js'
import { signLivekitToken, denyGuestIdentity, removeLivekitParticipant } from '../lib/livekit-admin.js'
import { deriveCallE2eeKey, getOrCreateCallSessionId } from '../lib/call-e2ee-session.js'
import {
  consumeKnock,
  getKnock,
  KNOCK_TTL_S,
  listPendingKnocksForCreator,
  releaseKnockSlot,
  rememberSeatHolder,
  reserveKnockSlot,
  saveKnock,
  type GuestKnock,
} from '../lib/guest-knock-store.js'
import { recordGuestJoined, recordGuestLeft } from '../lib/guest-call-log.js'
import { RESERVED_NICKNAMES } from '../lib/nickname.js'
import { areOnline, broadcastToUsers } from '../ws/registry.js'
import { sendNativePushToUser, sendPushToUser } from '../lib/push.js'
import { purgeGuestUser } from '../lib/guest-purge.js'

// ─── Knobs (env, defaults per concept §6.4) ─────────────────────────────────

const LINK_TTL_HOURS = Math.max(1, Number(process.env.GUEST_LINK_TTL_HOURS ?? 24))
const MAX_LINKS_PER_USER = Math.max(1, Number(process.env.GUEST_MAX_LINKS_PER_USER ?? 20))
const MAX_ACTIVE_GUESTS = Math.max(1, Number(process.env.GUEST_MAX_ACTIVE ?? 50))
const GUEST_CHAT_TTL_HOURS = Math.max(1, Number(process.env.GUEST_CHAT_TTL_HOURS ?? 12))
/** Default seats on a meeting link — a meeting is not a tête-à-tête. */
const MEETING_DEFAULT_SEATS = Math.min(
  50,
  Math.max(1, Number(process.env.GUEST_MEETING_SEATS ?? 10))
)

// ─── Schemas ────────────────────────────────────────────────────────────────

const tokenOnlySchema = z.object({ token: z.string().min(16).max(128) })

const knockBodySchema = z.object({
  token: z.string().min(16).max(128),
  nickname: z.string().min(1).max(64),
})

const enterBodySchema = z.object({
  token: z.string().min(16).max(128),
  nickname: z.string().min(1).max(64),
  public_key_jwk: z.string().min(1).max(4096),
  ecdh_public_key_jwk: z.string().min(1).max(4096),
})

const createInviteSchema = z.object({
  purpose: z.enum(['call', 'chat']),
  chat_id: z.string().uuid().optional(),
  can_publish: z.boolean().optional().default(true),
  /** Seats. Omitted → 1 for a temp chat, MEETING_DEFAULT_SEATS for a meeting. */
  max_uses: z.number().int().min(1).max(50).optional(),
})

const kickBodySchema = z.object({
  room: z.string().uuid(),
  identity: z.string().min(1).max(128),
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Guest display nickname: human text, NOT a handle. Trimmed, whitespace
 * collapsed, control/zero-width chars stripped, 1..32 chars.
 */
function sanitizeGuestNick(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < 1 || cleaned.length > 32) return null
  return cleaned
}

/**
 * Anti-impersonation (concept §8): a guest nick may not collide with any
 * existing handle (case-insensitively) or a reserved name. The check is an
 * accepted, rate-limited disclosure behind possession of a valid invite link.
 */
async function nickCollides(nick: string): Promise<boolean> {
  const lowered = nick.toLowerCase()
  if (RESERVED_NICKNAMES.has(lowered)) return true
  const candidate = lowered.replace(/\s+/g, '')
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) in (${lowered}, ${candidate})`)
    .limit(1)
  return Boolean(hit)
}

type LiveInvite = typeof guestInvites.$inferSelect

/**
 * An invite that still EXISTS: not revoked, not expired — seats not considered.
 * Only /guest/resolve uses this, to tell "the meeting is full right now" apart
 * from "this link is dead"; every state-creating path takes the stricter
 * lookup below. The extra disclosure needs possession of a real 192-bit token.
 */
async function findUnexpiredInviteByToken(token: string): Promise<LiveInvite | null> {
  const [row] = await db
    .select()
    .from(guestInvites)
    .where(
      and(
        eq(guestInvites.token, token),
        isNull(guestInvites.revokedAt),
        gt(guestInvites.expiresAt, new Date())
      )
    )
    .limit(1)
  return row ?? null
}

/** A usable invite: not revoked, seats left, not expired. Uniform miss. */
async function findLiveInviteByToken(token: string): Promise<LiveInvite | null> {
  const row = await findUnexpiredInviteByToken(token)
  if (!row || row.usedCount >= row.maxUses) return null
  return row
}

/** Wire shape of an invite — one place, so create/list never drift. */
function serializeInvite(row: LiveInvite) {
  return {
    id: row.id,
    token: row.token,
    purpose: row.purpose,
    chat_id: row.chatId,
    room_id: row.roomId,
    can_publish: row.canPublish,
    max_uses: row.maxUses,
    used_count: row.usedCount,
    /** No seats left: the link cannot admit anyone new (its room may be live). */
    exhausted: row.usedCount >= row.maxUses,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    path: `/guest/${row.purpose}/${row.token}`,
  }
}

/**
 * Take ONE seat on a link, atomically. The row-level guard is what makes
 * concurrent approvals safe: two hosts approving the last seat at once, or a
 * revoke racing an approve, and exactly one wins. `used_at` is stamped when the
 * final seat goes, keeping the sweeper's retention semantics unchanged.
 */
async function consumeInviteSeat(inviteId: string): Promise<boolean> {
  const taken = await db
    .update(guestInvites)
    .set({
      usedCount: sql`${guestInvites.usedCount} + 1`,
      usedAt: sql`case when ${guestInvites.usedCount} + 1 >= ${guestInvites.maxUses} then now() else ${guestInvites.usedAt} end`,
    })
    .where(
      and(
        eq(guestInvites.id, inviteId),
        isNull(guestInvites.revokedAt),
        gt(guestInvites.expiresAt, new Date()),
        sql`${guestInvites.usedCount} < ${guestInvites.maxUses}`
      )
    )
    .returning({ id: guestInvites.id })
  return taken.length > 0
}

function livekitReady(): boolean {
  return (
    getCallMediaMode() === 'self_hosted' &&
    Boolean(readSecret('LIVEKIT_API_KEY')) &&
    Boolean(readSecret('LIVEKIT_API_SECRET')) &&
    Boolean(process.env.LIVEKIT_URL?.trim())
  )
}

async function notifyKnock(
  creatorId: string,
  payload: { knock_id: string; nickname: string; chat_id: string | null; room_id: string }
): Promise<void> {
  broadcastToUsers([creatorId], { type: 'guest_knock', ...payload })
  const online = await areOnline([creatorId])
  if (!online.get(creatorId)) {
    const push = {
      type: 'guest_knock' as const,
      title: `🚪 ${payload.nickname}`,
      body: 'Гость стучится во встречу — откройте, чтобы впустить',
      url: payload.chat_id ? `/?chat=${payload.chat_id}` : '/',
      icon: '/icon-192.png',
      ...(payload.chat_id ? { chat_id: payload.chat_id } : {}),
    }
    sendPushToUser(creatorId, push).catch(() => {})
    sendNativePushToUser(creatorId, push).catch(() => {})
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const guestRoutes: FastifyPluginAsync = async (app) => {
  // ── Public surface (the ONLY unauthenticated app endpoints besides auth) ──
  // Per-IP limits in the auth-scope style; the poll endpoint gets its own
  // budget sized for 2-3s polling over the 5-minute knock window.
  //
  // BUDGETS ARE SIZED PER MEETING, NOT PER PERSON. Guests share an IP far more
  // often than the original 10-per-15-minutes budget assumed: everyone in one
  // office, one flat or one conference room is a single address. Each joining
  // guest spends 1 resolve + 1 knock, so a 10-seat meeting needs 20 — the old
  // budget locked out the sixth guest for a quarter of an hour, mid-meeting,
  // with a link that was still perfectly valid.
  //
  // The rate limit is NOT what protects a link: tokens are 32 random chars,
  // seats are capped in Postgres and live guests by GUEST_MAX_ACTIVE. It is
  // defence in depth against floods, so read-only resolve gets a wide budget
  // and the state-creating pair (knock/enter) a tighter one.
  //
  // The budgets ride on the APP-LEVEL limiter via per-route `config.rateLimit`
  // rather than a `register(rateLimit, …)` of their own: a nested registration
  // builds a fresh in-process LocalStore, so the counters died with every
  // `docker compose up -d --build api` and two api replicas each handed out a
  // full budget — exactly what app.ts registers the Redis store to prevent.
  // Per-route config reuses that store (namespaced per route, so the budgets
  // below stay independent of each other) and the app's allowList.
  const RESOLVE_MAX = Number(process.env.GUEST_RESOLVE_RATE_LIMIT_MAX ?? 60)
  const PUBLIC_MAX = Number(process.env.GUEST_PUBLIC_RATE_LIMIT_MAX ?? 30)
  const PUBLIC_WINDOW = process.env.GUEST_PUBLIC_RATE_LIMIT_WINDOW ?? '15 minutes'
  const POLL_MAX = Number(process.env.GUEST_POLL_RATE_LIMIT_MAX ?? 45)

  /**
   * Token → what am I joining? Uniform 404 for any dead/unknown token, and the
   * one exception: a link whose seats are all taken right now (409).
   */
  app.post(
    '/guest/resolve',
    { config: { rateLimit: { max: RESOLVE_MAX, timeWindow: PUBLIC_WINDOW } } },
    async (request, reply) => {
      const parsed = tokenOnlySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
      const invite = await findUnexpiredInviteByToken(parsed.data.token)
      if (!invite) return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
      // A full link is not a dead link. Seats are CONCURRENT capacity, so a
      // running meeting whose guests all have a seat used to answer the uniform
      // 404 — rendered as «Ссылка недействительна или истекла», i.e. a live
      // meeting telling its own guests the link had expired.
      if (invite.usedCount >= invite.maxUses) {
        return reply.status(409).send({ error: 'INVITE_FULL' })
      }
      const [creator] = await db
        .select({ username: users.username, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, invite.createdBy))
        .limit(1)
      return reply.send({
        kind: invite.purpose,
        host_name: creator?.displayName?.trim() || creator?.username || 'host',
        // Call links are joinable only when the SFU is actually configured —
        // tell the guest up front instead of failing after the knock.
        can_join: invite.purpose === 'call' ? livekitReady() && app.featureFlags.calls : true,
      })
    }
  )

  // knock + enter CREATE state (a Redis knock, a `users` row), so they keep the
  // tighter budget — still ~3 tries each for a full 10-seat meeting behind one
  // address, which is what the "Попробовать ещё раз" button costs after a deny.
  {
    const publicLimit = { config: { rateLimit: { max: PUBLIC_MAX, timeWindow: PUBLIC_WINDOW } } }

    /** Mechanism A step 1: knock. Creates NOTHING outside Redis. */
    app.post('/guest/knock', publicLimit, async (request, reply) => {
      const parsed = knockBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

      const invite = await findLiveInviteByToken(parsed.data.token)
      if (!invite || invite.purpose !== 'call') {
        return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
      }
      if (!livekitReady() || !app.featureFlags.calls) {
        return reply.status(503).send({ error: 'CALLS_NOT_AVAILABLE' })
      }

      const nick = sanitizeGuestNick(parsed.data.nickname)
      if (!nick) return reply.status(400).send({ error: 'INVALID_NICKNAME' })
      if (await nickCollides(nick)) {
        return reply.status(409).send({ error: 'NICKNAME_TAKEN' })
      }

      const roomId = invite.chatId ?? invite.roomId
      if (!roomId) return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })

      const knockId = randomUUID()
      // The waiting room holds at most as many guests as the link still has
      // seats for; an approve/deny/cancel/pickup frees a slot, and one nobody
      // ever answered expires on its own.
      const seatsLeft = Math.max(0, invite.maxUses - invite.usedCount)
      if (!(await reserveKnockSlot(invite.id, knockId, seatsLeft))) {
        return reply.status(429).send({ error: 'KNOCK_PENDING' })
      }
      const secret = randomBytes(24).toString('base64url')
      const knock: GuestKnock = {
        inviteId: invite.id,
        roomId,
        chatId: invite.chatId,
        creatorId: invite.createdBy,
        nickname: nick,
        secretHash: sha256hex(secret),
        canPublish: invite.canPublish,
        status: 'pending',
        grant: null,
        exp: Date.now() + KNOCK_TTL_S * 1000,
      }
      await saveKnock(knockId, knock)
      await notifyKnock(invite.createdBy, {
        knock_id: knockId,
        nickname: nick,
        chat_id: invite.chatId,
        room_id: roomId,
      })
      return reply.send({
        knock_id: knockId,
        knock_secret: secret,
        poll_interval_s: 2,
        ttl_s: KNOCK_TTL_S,
      })
    })

    /** Mechanism B: enter a temp chat. Consumes the link atomically. */
    app.post('/guest/enter', publicLimit, async (request, reply) => {
      const parsed = enterBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

      const invite = await findLiveInviteByToken(parsed.data.token)
      if (!invite || invite.purpose !== 'chat') {
        return reply.status(404).send({ error: 'INVITE_NOT_FOUND' })
      }

      const nick = sanitizeGuestNick(parsed.data.nickname)
      if (!nick) return reply.status(400).send({ error: 'INVALID_NICKNAME' })
      if (await nickCollides(nick)) {
        return reply.status(409).send({ error: 'NICKNAME_TAKEN' })
      }

      for (const jwkRaw of [parsed.data.public_key_jwk, parsed.data.ecdh_public_key_jwk]) {
        try {
          const jwk = JSON.parse(jwkRaw) as { kty?: string; crv?: string }
          if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('bad')
        } catch {
          return reply.status(400).send({ error: 'INVALID_KEY' })
        }
      }

      const [activeCnt] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.userGroup, 'guest'), gt(users.guestExpiresAt, new Date())))
      if (Number(activeCnt?.n ?? 0) >= MAX_ACTIVE_GUESTS) {
        return reply.status(503).send({ error: 'GUEST_CAPACITY' })
      }

      // Take the seat first; the row-level guard makes the race safe. Temp-chat
      // links are single-seat, so this is the one-time burn it always was.
      // Losing that race means the seat is gone, not that the link is bogus —
      // same distinction /guest/resolve now draws.
      if (!(await consumeInviteSeat(invite.id))) {
        return reply.status(409).send({ error: 'INVITE_FULL' })
      }

      const expiresAt = new Date(Date.now() + GUEST_CHAT_TTL_HOURS * 3600_000)
      let guestId: string | null = null
      let guestUsername = ''
      let chatId = ''
      for (let attempt = 0; attempt < 5 && !guestId; attempt++) {
        guestUsername = `guest_${randomBytes(4).toString('hex')}`
        try {
          const created = await db.transaction(async (tx) => {
            const [guestRow] = await tx
              .insert(users)
              .values({
                username: guestUsername,
                publicKeyJwk: parsed.data.public_key_jwk,
                ecdhPublicKeyJwk: parsed.data.ecdh_public_key_jwk,
                displayName: nick,
                userGroup: 'guest',
                isDiscoverable: false,
                guestExpiresAt: expiresAt,
                guestInvitedBy: invite.createdBy,
              })
              .returning({ id: users.id })
            if (!guestRow) throw new Error('INSERT_GUEST_FAILED')
            const [chatRow] = await tx
              .insert(chats)
              .values({ type: 'direct_e2e', name: null })
              .returning({ id: chats.id })
            if (!chatRow) throw new Error('INSERT_CHAT_FAILED')
            await tx.insert(chatMembers).values([
              { chatId: chatRow.id, userId: invite.createdBy, encryptedGroupKey: null, role: 'member' as const },
              { chatId: chatRow.id, userId: guestRow.id, encryptedGroupKey: null, role: 'member' as const },
            ])
            return { guestId: guestRow.id, chatId: chatRow.id }
          })
          guestId = created.guestId
          chatId = created.chatId
        } catch (e: unknown) {
          if ((e as { code?: string }).code === '23505') continue // handle collision — retry
          throw e
        }
      }
      if (!guestId) return reply.status(500).send({ error: 'GUEST_CREATE_FAILED' })

      broadcastToUsers([invite.createdBy], {
        type: 'guest_joined',
        chat_id: chatId,
        guest_user_id: guestId,
        nickname: nick,
      })
      broadcastToUsers([invite.createdBy], { type: 'chats_updated' })
      const online = await areOnline([invite.createdBy])
      if (!online.get(invite.createdBy)) {
        const push = {
          type: 'guest_knock' as const,
          title: `🚪 ${nick}`,
          body: 'Гость вошёл во временный чат',
          url: `/?chat=${chatId}`,
          icon: '/icon-192.png',
          chat_id: chatId,
        }
        sendPushToUser(invite.createdBy, push).catch(() => {})
        sendNativePushToUser(invite.createdBy, push).catch(() => {})
      }

      // The guest now logs in via the normal challenge/verify with this handle
      // and their in-tab key; the session is minted short with grp:'guest'.
      return reply.send({
        username: guestUsername,
        user_id: guestId,
        chat_id: chatId,
        expires_at: expiresAt.toISOString(),
      })
    })
  }

  // Poll gets its own generous budget: 2-3s polling for the 5-minute window.
  {
    const pollLimit = { config: { rateLimit: { max: POLL_MAX, timeWindow: '1 minute' } } }

    /** Mechanism A step 2: poll the knock. Approved/denied is a ONE-TIME read. */
    app.get('/guest/knock/:id', pollLimit, async (request, reply) => {
      const { id } = request.params as { id: string }
      const secret = (request.query as { secret?: string }).secret ?? ''
      const knock = await getKnock(id)
      if (!knock || sha256hex(secret) !== knock.secretHash) {
        return reply.status(404).send({ error: 'KNOCK_NOT_FOUND' })
      }
      if (knock.status === 'pending') {
        return reply.send({ status: 'pending' })
      }
      await consumeKnock(id)
      await releaseKnockSlot(knock.inviteId, id)
      if (knock.status === 'denied' || !knock.grant) {
        return reply.send({ status: 'denied' })
      }
      reply.header('Cache-Control', 'no-store')
      return reply.send({
        status: 'approved',
        room: knock.roomId,
        identity: knock.grant.identity,
        livekit_url: knock.grant.livekitUrl,
        token: knock.grant.token,
        call_e2ee_key: knock.grant.e2eeKey,
      })
    })

    /** The guest changed their mind while waiting. */
    app.post('/guest/knock/:id/cancel', pollLimit, async (request, reply) => {
      const { id } = request.params as { id: string }
      const secret = ((request.body ?? {}) as { secret?: string }).secret ?? ''
      const knock = await getKnock(id)
      if (!knock || sha256hex(secret) !== knock.secretHash) {
        return reply.status(404).send({ error: 'KNOCK_NOT_FOUND' })
      }
      await consumeKnock(id)
      await releaseKnockSlot(knock.inviteId, id)
      broadcastToUsers([knock.creatorId], { type: 'guest_knock_cancelled', knock_id: id })
      return reply.send({ ok: true })
    })
  }

  // ── Authenticated surface (creator side + guest self-destruct) ────────────

  /** Create a one-time guest link. */
  app.post('/guest-invites', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group === 'guest') return reply.status(403).send({ error: 'GUEST_FORBIDDEN' })

    const parsed = createInviteSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const { purpose, chat_id: chatId, can_publish: canPublish } = parsed.data
    // A temp chat is a tête-à-tête (one guest, ever). A meeting link seats
    // several — the host still approves each guest individually.
    const maxUses =
      parsed.data.max_uses ?? (purpose === 'chat' ? 1 : MEETING_DEFAULT_SEATS)
    if (purpose === 'chat' && maxUses !== 1) {
      return reply.status(400).send({ error: 'CHAT_LINK_IS_SINGLE_SEAT' })
    }

    if (purpose === 'call' && !app.featureFlags.calls) {
      return reply.status(403).send({ error: 'CALLS_DISABLED' })
    }

    // Call link bound to an existing chat requires membership there; the room
    // for a standalone call link is a fresh uuid that is NOT a chat.
    let roomId: string | null = null
    if (purpose === 'call') {
      if (chatId) {
        const [membership] = await db
          .select({ chatId: chatMembers.chatId })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
          .limit(1)
        if (!membership) return reply.status(403).send({ error: 'NOT_A_MEMBER' })
      } else {
        roomId = randomUUID()
      }
    } else if (chatId) {
      return reply.status(400).send({ error: 'CHAT_ID_NOT_ALLOWED' })
    }

    const [cnt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(guestInvites)
      .where(
        and(
          eq(guestInvites.createdBy, user.id),
          isNull(guestInvites.revokedAt),
          sql`${guestInvites.usedCount} < ${guestInvites.maxUses}`,
          gt(guestInvites.expiresAt, new Date())
        )
      )
    if (Number(cnt?.n ?? 0) >= MAX_LINKS_PER_USER) {
      return reply.status(429).send({ error: 'TOO_MANY_LINKS' })
    }

    const token = randomBytes(24).toString('base64url') // 192 bits
    const [row] = await db
      .insert(guestInvites)
      .values({
        token,
        purpose,
        createdBy: user.id,
        chatId: purpose === 'call' ? chatId ?? null : null,
        roomId,
        canPublish,
        maxUses,
        expiresAt: new Date(Date.now() + LINK_TTL_HOURS * 3600_000),
      })
      .returning()
    if (!row) return reply.status(500).send({ error: 'INSERT_FAILED' })
    return reply.send(serializeInvite(row))
  })

  /**
   * My links.
   *
   * Deliberately NOT filtered by remaining seats: a link the creator can no
   * longer hand out is still the handle on a LIVE meeting (its room is where
   * the guests are) and on a temp chat that exists. Hiding used links made
   * them look like they had vanished — and left an instant meeting with no
   * way back in. Exhausted links come back flagged, and the client renders
   * them as "войти" rather than "скопировать".
   */
  app.get('/guest-invites', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group === 'guest') return reply.status(403).send({ error: 'GUEST_FORBIDDEN' })
    const rows = await db
      .select()
      .from(guestInvites)
      .where(
        and(
          eq(guestInvites.createdBy, user.id),
          isNull(guestInvites.revokedAt),
          gt(guestInvites.expiresAt, new Date())
        )
      )
      .orderBy(desc(guestInvites.createdAt))
    return reply.send({ invites: rows.map(serializeInvite) })
  })

  /** Revoke a link ("leaked to the wrong person"). */
  app.delete('/guest-invites/:id', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { id } = request.params as { id: string }
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: 'INVALID_ID' })
    }
    const updated = await db
      .update(guestInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(guestInvites.id, id),
          eq(guestInvites.createdBy, user.id),
          isNull(guestInvites.revokedAt)
        )
      )
      .returning({ id: guestInvites.id })
    if (updated.length === 0) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send({ ok: true })
  })

  /** Approve a pending knock — creator only. Burns the link, mints the grant. */
  app.post('/guest/knock/:id/approve', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { id } = request.params as { id: string }
    const knock = await getKnock(id)
    if (!knock || knock.status !== 'pending') {
      return reply.status(404).send({ error: 'KNOCK_NOT_FOUND' })
    }
    if (knock.creatorId !== user.id) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }
    // Creating the link is not a standing right over the chat's room. A link
    // outlived the membership that authorized it: its creator leaves (or is
    // removed) and the invite still mints a LiveKit token for THIS chat's room
    // plus the exact media key the remaining members hold — for a stranger.
    // Their own /call/token is already refused, so the system knows they are
    // unauthorized; it just kept letting them mint entry for someone else.
    if (knock.chatId) {
      const [membership] = await db
        .select({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, knock.chatId), eq(chatMembers.userId, user.id)))
        .limit(1)
      if (!membership) return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const apiKey = readSecret('LIVEKIT_API_KEY')
    const apiSecret = readSecret('LIVEKIT_API_SECRET')
    const livekitUrl = process.env.LIVEKIT_URL?.trim()
    if (!livekitReady() || !apiKey || !apiSecret || !livekitUrl) {
      return reply.status(503).send({ error: 'LIVEKIT_NOT_CONFIGURED' })
    }
    if (apiSecret.length < 32) {
      return reply.status(503).send({ error: 'LIVEKIT_SECRET_TOO_SHORT' })
    }

    // Take a seat; a concurrent revoke, an expiry, or the last seat going to
    // another guest loses here.
    if (!(await consumeInviteSeat(knock.inviteId))) {
      await consumeKnock(id)
      await releaseKnockSlot(knock.inviteId, id)
      return reply.status(409).send({ error: 'INVITE_GONE' })
    }

    const now = Math.floor(Date.now() / 1000)
    const ttlSeconds = resolveCallTokenTtlSeconds()
    const identity = `guest:${randomBytes(6).toString('hex')}`
    const token = signLivekitToken(apiKey, apiSecret, {
      iss: apiKey,
      sub: identity,
      nbf: now - 5,
      exp: now + ttlSeconds,
      jti: `${identity}.${knock.roomId}.${now}`,
      name: knock.nickname,
      metadata: JSON.stringify({ guest: true, invited_by: user.username }),
      video: {
        room: knock.roomId,
        roomJoin: true,
        canPublish: knock.canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    })
    const callSessionId = await getOrCreateCallSessionId(knock.roomId, ttlSeconds + 60 * 5)
    const e2eeKey = deriveCallE2eeKey(apiSecret, knock.roomId, callSessionId)

    await saveKnock(id, {
      ...knock,
      status: 'approved',
      grant: { livekitUrl, token, identity, e2eeKey },
    })
    // The waiting room slot has done its job — the seat in Postgres is what
    // caps this guest now. Holding it until the pickup poll (which a guest who
    // closed the tab never sends) kept the door shut behind them.
    await releaseKnockSlot(knock.inviteId, id)
    // Remember whose seat this is, so participant_left can give it back.
    await rememberSeatHolder(knock.roomId, identity, knock.inviteId)
    await recordGuestJoined(knock.roomId, identity, knock.nickname)
    return reply.send({ ok: true, identity })
  })

  /**
   * Knocks currently waiting at this creator's door.
   *
   * The `guest_knock` WS push is fire-and-forget: a host with no live socket
   * (offline, or simply mid-reload) got a notification and nothing else, and
   * the overlay is event-only — the knock could never be approved, it just
   * expired at the door. This is the hydration source, mirroring the group-call
   * hydration on WS connect in ws.ts. Same fields as the WS message so the
   * overlay can render either without a second shape.
   */
  app.get('/guest/knocks', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group === 'guest') return reply.status(403).send({ error: 'GUEST_FORBIDDEN' })
    const pending = await listPendingKnocksForCreator(user.id)
    return reply.send({
      knocks: pending.map(({ id, knock }) => ({
        knock_id: id,
        nickname: knock.nickname,
        chat_id: knock.chatId,
        room_id: knock.roomId,
        expires_at: new Date(knock.exp).toISOString(),
      })),
    })
  })

  /** Deny a pending knock — creator only. The link survives (revoke is separate). */
  app.post('/guest/knock/:id/deny', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { id } = request.params as { id: string }
    const knock = await getKnock(id)
    if (!knock || knock.status !== 'pending') {
      return reply.status(404).send({ error: 'KNOCK_NOT_FOUND' })
    }
    if (knock.creatorId !== user.id) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }
    await saveKnock(id, { ...knock, status: 'denied' })
    await releaseKnockSlot(knock.inviteId, id)
    return reply.send({ ok: true })
  })

  /**
   * Kick a call guest. Allowed for the link creator (any invite of theirs for
   * this room) and, for chat-bound rooms, chat admins/owners (§10.4).
   */
  app.post('/guest-calls/kick', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group === 'guest') return reply.status(403).send({ error: 'GUEST_FORBIDDEN' })
    const parsed = kickBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const { room, identity } = parsed.data
    if (!identity.startsWith('guest:')) {
      return reply.status(400).send({ error: 'NOT_A_GUEST' })
    }

    const [membership] = await db
      .select({ role: chatMembers.role })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, room), eq(chatMembers.userId, user.id)))
      .limit(1)
    let allowed = membership?.role === 'admin' || membership?.role === 'owner'
    if (!allowed) {
      const ownInvites = await db
        .select({ chatId: guestInvites.chatId })
        .from(guestInvites)
        .where(
          and(
            eq(guestInvites.createdBy, user.id),
            sql`(${guestInvites.chatId} = ${room} or ${guestInvites.roomId} = ${room})`
          )
        )
        .limit(10)
      // Having made a link is not a standing right over someone else's room:
      // a creator who has since left the chat keeps none of it (same reason
      // approve re-checks membership). A STANDALONE guest room is not a chat
      // and has no members — there its creator stays in charge.
      allowed = ownInvites.some((inv) => inv.chatId === null || Boolean(membership))
    }
    if (!allowed) return reply.status(403).send({ error: 'FORBIDDEN' })

    await denyGuestIdentity(room, identity)
    const removed = await removeLivekitParticipant(room, identity)
    await recordGuestLeft(room, identity, true).catch(() => {})
    if (!removed) {
      // The denylist is the durable half, but it is only consulted from the
      // participant_joined webhook — i.e. it bites only if the guest leaves and
      // comes back. Reporting ok:true for a kick LiveKit never performed left
      // the host looking at a guest who is still in the call and a UI that said
      // it worked.
      request.log.warn(
        { room, identity },
        'guest kick: LiveKit did not remove the participant'
      )
      return reply.status(502).send({ error: 'KICK_NOT_APPLIED' })
    }
    return reply.send({ ok: true, removed })
  })

  /**
   * The HOST's side of "выйти": end a temp chat early.
   *
   * A guest could always destroy their own session, and the sweeper eventually
   * takes care of the rest, but the person who handed out the link had no way
   * to end it — a link sent to the wrong person meant waiting out the TTL with
   * a stranger sitting in the chat. Same purge as the guest's own leave (the
   * ephemeral account AND the chat go together), gated on the caller being the
   * OTHER member of that very chat.
   */
  app.post('/guest-chats/:chatId/kick', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group === 'guest') return reply.status(403).send({ error: 'GUEST_FORBIDDEN' })
    const { chatId } = request.params as { chatId: string }
    if (!z.string().uuid().safeParse(chatId).success) {
      return reply.status(400).send({ error: 'INVALID_ID' })
    }

    const members = await db
      .select({ userId: chatMembers.userId, group: users.userGroup })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(eq(chatMembers.chatId, chatId))
    if (!members.some((m) => m.userId === user.id)) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }
    const guest = members.find((m) => m.userId !== user.id && m.group === 'guest')
    if (!guest) return reply.status(404).send({ error: 'NO_GUEST_IN_CHAT' })

    const result = await purgeGuestUser(guest.userId)
    if (!result.ok) return reply.status(500).send({ error: 'PURGE_FAILED' })
    return reply.send({ ok: true })
  })

  /** Guest self-destruct ("Выйти"): purge the account + the temp chat now. */
  app.post('/guest/me/leave', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    if (user.group !== 'guest') return reply.status(403).send({ error: 'NOT_A_GUEST' })
    const result = await purgeGuestUser(user.id)
    if (!result.ok) return reply.status(500).send({ error: 'PURGE_FAILED' })
    return reply.send({ ok: true })
  })
}

import { and, eq, inArray, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { db } from '../db/index.js'
import { persistChatMessageAndFanOut } from '../lib/chat-message-persist.js'
import { callSessions, chatMembers, messageReactions, messages, userBlocks, users } from '../db/schema.js'
import {
  getAuthUser,
  isUserDeviceSessionValid,
  assertDeviceActiveForUser,
  type AuthUser,
} from '../lib/auth-user.js'
import { isJtiDenied } from '../lib/jwt-denylist.js'
import { getRedis } from '../lib/redis.js'
import { normalizeUuid } from '../lib/uuid.js'
import { markMessageReadByReader } from '../lib/mark-message-read.js'
import {
  broadcastOnlineStatusChange,
  clearPingWriteAt,
  getRelatedUserIds,
  getUserChatIds,
  touchLastSeen,
  touchLastSeenPing,
} from '../lib/presence.js'
import { isBlocked } from '../lib/block-check.js'
import { getCachedCallAuth, setCachedCallAuth } from '../lib/call-auth-cache.js'
import {
  areOnline,
  broadcastToUsers,
  hasActiveSocket,
  isOnline,
  registerUserSocket,
  sendToUser,
} from '../ws/registry.js'
import { sendNativePushToUser, sendPushToUser } from '../lib/push.js'
import {
  joinRoom,
  leaveRoom,
  leaveAllRooms,
  getRoomParticipantIds,
  isUserInRoom,
  updateParticipantState,
} from '../ws/group-call-rooms.js'

type WsAuthResult = {
  user: AuthUser
  jti?: string
  device_id?: string
}

type HeartbeatSocket = WebSocket & {
  __isAlive?: boolean
}

/**
 * Resolves authenticated websocket user from session cookie or ws ticket JWT.
 * The ticket path is used when the browser does not include cookies during WS upgrade.
 * Returns user + session metadata (jti, device_id) for ongoing revocation checks.
 */
async function resolveWsUser(request: FastifyRequest): Promise<WsAuthResult | null> {
  // Try cookie-based auth first
  const fromCookie = await getAuthUser(request)
  if (fromCookie) {
    // Extract JTI and device_id from the cookie JWT for ongoing checks
    const { readFmSessionToken } = await import('../lib/session-cookie.js')
    const token = readFmSessionToken(request)
    let jti: string | undefined
    let device_id: string | undefined
    if (token) {
      try {
        const payload = await request.server.jwt.verify<{
          jti?: string
          device_id?: string
        }>(token)
        jti = payload.jti
        device_id = payload.device_id
      } catch { /* token verification handled elsewhere */ }
    }
    return { user: fromCookie, jti, device_id }
  }

  const q = request.query as { ticket?: string }
  const ticket = q?.ticket?.trim()
  if (!ticket) return null
  try {
    const p = await request.server.jwt.verify<{
      sub: string
      username: string
      scope?: string
      device_id?: string
      jti?: string
    }>(ticket)
    if (p.scope !== 'ws' || !p.sub || !p.username) return null
    const id = normalizeUuid(p.sub)
    if (!(await isUserDeviceSessionValid(id, p.device_id))) return null
    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        isDiscoverable: users.isDiscoverable,
        isBanned: users.isBanned,
        role: users.role,
        userGroup: users.userGroup,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
    if (!row || row.isBanned) return null
    return {
      user: {
        id: normalizeUuid(row.id),
        username: row.username,
        is_discoverable: row.isDiscoverable,
        role: row.role === 'admin' ? 'admin' : 'user',
        group: row.userGroup ?? 'regular',
      },
      jti: p.jti,
      device_id: p.device_id,
    }
  } catch {
    return null
  }
}

const webrtcSignalSchema = z.object({
  type: z.literal('webrtc_signal'),
  targetUserId: z.string().uuid(),
  signalData: z.unknown(),
})

const callInviteSchema = z.object({
  type: z.literal('call_invite'),
  chat_id: z.string().uuid(),
  is_video: z.boolean().default(false),
})

const callLeaveSchema = z.object({
  type: z.literal('call_leave'),
  chat_id: z.string().uuid(),
})

const callRejectSchema = z.object({
  type: z.literal('call_reject'),
  chat_id: z.string().uuid(),
})

const callAcceptSchema = z.object({
  type: z.literal('call_accept'),
  chat_id: z.string().uuid(),
})

const messageReadSchema = z.object({
  type: z.literal('message_read'),
  chat_id: z.string().uuid(),
  message_id: z.string().uuid(),
})

const typingStartSchema = z.object({
  type: z.literal('typing_start'),
  chat_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
})

const typingStopSchema = z.object({
  type: z.literal('typing_stop'),
  chat_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
})

const presencePingSchema = z.object({
  type: z.literal('presence_ping'),
})

// --- Group Call Schemas ---
const groupCallJoinSchema = z.object({
  type: z.literal('group_call:join'),
  room_id: z.string().uuid(),
  is_video: z.boolean().default(false),
})

const groupCallLeaveSchema = z.object({
  type: z.literal('group_call:leave'),
  room_id: z.string().uuid(),
})

const groupCallOfferSchema = z.object({
  type: z.literal('group_call:offer'),
  room_id: z.string().uuid(),
  target_user_id: z.string().uuid(),
  sdp: z.string(),
  is_video: z.boolean().default(false),
})

const groupCallAnswerSchema = z.object({
  type: z.literal('group_call:answer'),
  room_id: z.string().uuid(),
  target_user_id: z.string().uuid(),
  sdp: z.string(),
})

const groupCallIceSchema = z.object({
  type: z.literal('group_call:ice'),
  room_id: z.string().uuid(),
  target_user_id: z.string().uuid(),
  candidate: z.unknown(),
})

const groupCallMuteSchema = z.object({
  type: z.literal('group_call:mute'),
  room_id: z.string().uuid(),
  is_muted: z.boolean(),
})

const groupCallVideoToggleSchema = z.object({
  type: z.literal('group_call:video_toggle'),
  room_id: z.string().uuid(),
  is_video_off: z.boolean(),
})

const groupCallSpeakingSchema = z.object({
  type: z.literal('group_call:speaking'),
  room_id: z.string().uuid(),
  is_speaking: z.boolean(),
})

const groupCallRelayFrameSchema = z.object({
  type: z.literal('group_call:relay_frame'),
  room_id: z.string().uuid(),
  target_user_id: z.string().uuid(),
  ciphertext: z.string().min(1).max(16_384),
  iv: z.string().min(1).max(256),
  sample_rate: z.number().int().min(8_000).max(192_000),
  // Position in the sender's stream. Relayed verbatim (the server cannot read
  // the frame anyway) — the RECEIVER rejects a non-increasing seq and folds it
  // into the AAD, which is what stops a captured frame replaying. Same scheme
  // the 1:1 relay already uses.
  //
  // OPTIONAL on purpose. A client that predates this field would fail the whole
  // schema, and the fall-through sends back `UNKNOWN_MESSAGE_TYPE` — once per
  // audio frame, so ~50 error messages a second down that socket. Accepting the
  // frame and letting the receiver drop it costs nothing: enforcement lives on
  // the receiving client either way, and a frame with no seq never opens.
  seq: z.number().int().nonnegative().optional(),
})

const toggleReactionSchema = z.object({
  type: z.literal('toggle_reaction'),
  message_id: z.string().uuid(),
  chat_id: z.string().uuid(),
  emoji: z.string().min(1).max(32),
})

/** Safe ws.send that checks readyState and swallows errors on closing sockets. */
function safeSend(ws: WebSocket, data: string) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(data)
    } catch {
      // Ignore sends racing with socket shutdown.
    }
  }
}

/** Maximum allowed WebSocket message size (64 KB — sufficient for E2E ciphertext). */
export const MAX_WS_MESSAGE_BYTES = 64 * 1024

/** Per-connection rate limit: max messages per window. */
const WS_RATE_LIMIT_MAX = 60
/** Call SIGNALING (webrtc_signal offer/answer/ice, group_call:* control) needs a
 *  higher budget than chat control traffic: a single mesh join emits an offer +
 *  10-20 ICE candidates per peer pair, and a 1:1 call promoted into a 3-person
 *  group can exceed 60 msgs/min from one honest client — the limiter then
 *  silently dropped signaling and calls half-connected (issue #1/#4). */
const WS_RATE_LIMIT_SIGNALING_MAX = 600
const WS_RATE_LIMIT_RELAY_MAX = 2400
const WS_RATE_LIMIT_WINDOW_MS = 60_000

/** How long a server-CONFIRMED call keeps a connection in the elevated tier.
 *  Renewed by frames the server itself authorizes, so a real call never decays
 *  mid-session while an idle claimant does. */
const IN_CALL_TTL_MS = 120_000
/** An unanswered `call_invite` buys the caller only enough time to finish its
 *  ICE burst; if nobody answers it must decay back to the control tier. */
const IN_CALL_BOOTSTRAP_MS = 30_000
/** How many unanswered `call_invite` bootstraps one CONNECTION may claim before
 *  a peer actually answers. Redialing a few times is normal; the previous code
 *  let an attacker chain invite → relay_offer → relay_frame and re-arm the
 *  120s grant forever without the callee ever seeing a ring. Reset by a real
 *  server-confirmed call. */
const MAX_BOOTSTRAP_GRANTS = 3
/** Upper bound on a 1:1 `webrtc_signal` relay_frame. `signalData` is
 *  `z.unknown()`, so only the 64KB frame ceiling applied and a frame padded to
 *  ~63KB could be fired at the 2400/min relay tier — ~150 MB/min of
 *  JSON.stringify + fan-out per socket. An honest relay_frame carries the same
 *  payload `groupCallRelayFrameSchema` already bounds (16KB ciphertext + a
 *  256B iv), so this is the equivalent ceiling with envelope headroom. Size
 *  only — the blob itself stays opaque. */
const MAX_RELAY_FRAME_BYTES = 20 * 1024
/** Ring fan-out ceiling for `call_invite`. Ringing every member of a
 *  5,000-member public_open channel is meaningless as a product behaviour and
 *  is a free amplifier: one frame turned into a full member-list load, a block
 *  lookup and an offline-push decision per member, at 60 invites/min × 12
 *  sockets. Mesh calling is impractical well below this. */
const MAX_CALL_INVITE_MEMBERS = 64
/** Consecutive undecodable frames before the socket is hung up. An honest
 *  client never emits invalid JSON; a hostile one used to get an unlimited
 *  warn-log + error-reply loop out of the 2-byte payload `{"` because the parse
 *  failure returned BEFORE the rate limiter ran. */
const MAX_INVALID_JSON_FRAMES = 10

type WsRateBucket = 'control' | 'call'
export type WsRateTier = { bucket: WsRateBucket; limit: number }

/** Sliding-window rate limiter with INDEPENDENT buckets per connection.
 *
 *  Control and call traffic must not share one window: a 600-frame signaling
 *  burst previously consumed the whole 60/min budget, starving presence_ping,
 *  read receipts and typing for the rest of the minute for an HONEST in-call
 *  client. */
class WsRateLimiter {
  private windows = new Map<WsRateBucket, number[]>()

  check(tier: WsRateTier): boolean {
    const now = Date.now()
    const cutoff = now - WS_RATE_LIMIT_WINDOW_MS
    const kept = (this.windows.get(tier.bucket) ?? []).filter((t) => t > cutoff)
    if (kept.length >= tier.limit) {
      this.windows.set(tier.bucket, kept)
      return false
    }
    kept.push(now)
    this.windows.set(tier.bucket, kept)
    return true
  }
}

/**
 * Pick the rate tier for a frame.
 *
 * SECURITY (#24): the elevated budgets are CONJUNCTIVE — they require that the
 * SERVER has already placed this connection in a call (`inCall`), not merely
 * that the frame claims a call-ish `type`. This runs before any zod parse and
 * before isMemberOfChat / isUserInRoom, so keying off the client-supplied type
 * alone let ANY authenticated connection claim 2400 msg/min just by sending
 * `{"type":"group_call:relay_frame"}` — with no call, no membership and no
 * authorization of any kind (and 12 sockets are allowed per user).
 *
 * The four call-CONTROL frames stay on the control bucket: they are what create
 * the in-call state, so they cannot require it, and one per call attempt fits
 * the 60/min budget comfortably.
 */
export function resolveWsRateLimit(json: unknown, inCall: boolean): WsRateTier {
  const control: WsRateTier = { bucket: 'control', limit: WS_RATE_LIMIT_MAX }
  if (!json || typeof json !== 'object') return control
  const entry = json as {
    type?: unknown
    signalData?: { kind?: unknown } | null
  }
  const type = entry.type

  if (
    type === 'call_invite' ||
    type === 'call_accept' ||
    type === 'call_reject' ||
    type === 'call_leave'
  ) {
    return control
  }

  // Not in a server-confirmed call → no elevated budget, whatever it claims.
  if (!inCall) return control

  if (
    (type === 'webrtc_signal' && entry.signalData?.kind === 'relay_frame') ||
    type === 'group_call:relay_frame'
  ) {
    return { bucket: 'call', limit: WS_RATE_LIMIT_RELAY_MAX }
  }
  if (
    type === 'webrtc_signal' ||
    (typeof type === 'string' && type.startsWith('group_call:'))
  ) {
    return { bucket: 'call', limit: WS_RATE_LIMIT_SIGNALING_MAX }
  }
  return control
}

export type CallTierGrant = {
  /** Is this connection in the elevated tier right now? */
  isInCall: () => boolean
  /** GRANT (or extend) the elevated tier from a SERVER-VERIFIED event: an
   *  answered ring, or a completed room join. */
  markInCall: (ttlMs: number) => void
  /** Short, NON-RENEWABLE grant for an outgoing ring nobody has answered yet. */
  markCallBootstrap: () => void
  /** RENEW an already-CONFIRMED grant. Never creates one, and never touches the
   *  bootstrap deadline. */
  refreshInCall: () => void
  clearInCall: () => void
}

/**
 * Per-connection state machine for the elevated (call) rate tier (#24).
 *
 * The limiter runs on EVERY frame (up to 2400/min), so this is synchronous local
 * memory — never a Redis read. Deadlines rather than booleans, so a connection
 * decays back to the control tier unless the server keeps confirming the call.
 *
 * The CALLER's unilateral `call_invite` bootstrap is tracked SEPARATELY from the
 * server-confirmed deadline, because a single deadline made the original gate
 * bypassable: an invite (which nobody has to answer) created a grant, and
 * `refreshInCall()` — driven by the sender's OWN relay_offer, which the server
 * authorizes purely from "these two share a chat" — then saw "a grant exists"
 * and pushed it out to the full TTL, forever. Split, a bootstrap can never be
 * renewed, only re-earned, and only MAX_BOOTSTRAP_GRANTS times until a peer
 * actually answers.
 */
export function createCallTierGrant(): CallTierGrant {
  let inCallUntil = 0
  let bootstrapUntil = 0
  let bootstrapGrants = 0
  return {
    isInCall: () => {
      const now = Date.now()
      return now < inCallUntil || now < bootstrapUntil
    },
    markInCall: (ttlMs: number) => {
      const until = Date.now() + ttlMs
      if (until > inCallUntil) inCallUntil = until
      // A peer really answered / the server really put us in a room, so the
      // anti-pinning bootstrap budget starts over.
      bootstrapGrants = 0
    },
    markCallBootstrap: () => {
      if (bootstrapGrants >= MAX_BOOTSTRAP_GRANTS) return
      bootstrapGrants += 1
      const until = Date.now() + IN_CALL_BOOTSTRAP_MS
      if (until > bootstrapUntil) bootstrapUntil = until
    },
    refreshInCall: () => {
      if (inCallUntil > Date.now()) inCallUntil = Date.now() + IN_CALL_TTL_MS
    },
    clearInCall: () => {
      inCallUntil = 0
      bootstrapUntil = 0
    },
  }
}

/** Returns the byte length of a raw websocket payload for size validation. */
function rawByteLength(raw: unknown): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8')
  if (Buffer.isBuffer(raw)) return raw.length
  if (raw instanceof ArrayBuffer) return raw.byteLength
  if (Array.isArray(raw)) return raw.reduce((acc, b) => acc + (Buffer.isBuffer(b) ? b.length : Buffer.from(b).length), 0)
  return 0
}

/** Converts websocket payload variants into UTF-8 text for JSON parsing. */
function bufferToString(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8')
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((b) => Buffer.from(b))).toString('utf8')
  }
  return ''
}

/** Verifies chat membership for a user to enforce zero-trust chat boundaries. */
async function isMemberOfChat(chatId: string, userId: string): Promise<boolean> {
  const member = await db
    .select({ one: chatMembers.userId })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
    .limit(1)
  return member.length > 0
}

/** Returns all member ids of a chat for secure fan-out routing. */
async function getChatMemberIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
  return rows.map((m) => m.userId)
}

/**
 * Drops every candidate that is in a block relationship with `userId`, in ONE
 * query.
 *
 * The call_invite fan-out previously ran `isBlocked()` per candidate
 * CONCURRENTLY: a 5,000-member channel meant 5,000 simultaneous SELECTs against
 * a 20-connection pool from a single frame — and the control tier allows 60
 * invites/min per socket. One set query is O(1) connections regardless of chat
 * size.
 */
async function filterOutBlocked(userId: string, candidateIds: string[]): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const rows = await db
    .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, userId), inArray(userBlocks.blockedId, candidateIds)),
        and(eq(userBlocks.blockedId, userId), inArray(userBlocks.blockerId, candidateIds))
      )
    )
  if (rows.length === 0) return candidateIds
  const blocked = new Set<string>()
  for (const row of rows) {
    blocked.add(row.blockerId === userId ? row.blockedId : row.blockerId)
  }
  return candidateIds.filter((id) => !blocked.has(id))
}

async function ensureGroupCallTargetInRoom(
  roomId: string,
  targetUserId: string
): Promise<boolean> {
  return isUserInRoom(roomId, targetUserId)
}

export const wsRoutes: FastifyPluginAsync = async (app) => {
  /** WebSocket endpoint handling chat events, read receipts, and WebRTC signaling. */
  app.get('/ws', { websocket: true }, (ws: WebSocket, request: FastifyRequest) => {
    const correlationId = randomUUID()
    const pending: unknown[] = []
    const MAX_PENDING = 20
    let authed: AuthUser | null = null
    /** Session metadata for ongoing revocation checks. */
    let sessionJti: string | undefined
    let sessionDeviceId: string | undefined
    const rateLimiter = new WsRateLimiter()

    // #24: server-owned "this connection is in a call" state. Closure-scoped: it
    // dies with the socket.
    const { isInCall, markInCall, markCallBootstrap, refreshInCall, clearInCall } =
      createCallTierGrant()
    /** In-room check that also renews the grant (#24). Authoritative server-side
     *  room state is the only thing allowed to keep the elevated tier alive, so a
     *  user who left (or never joined) decays within one TTL and cannot pin. */
    const isUserInRoomTracked = async (roomId: string, userId: string): Promise<boolean> => {
      const ok = await isUserInRoom(roomId, userId)
      if (ok) markInCall(IN_CALL_TTL_MS)
      else clearInCall()
      return ok
    }

    // Group-call rooms THIS SOCKET joined. Room membership used to be released
    // only from the registry's last-socket-closed callback, so a user with two
    // sockets (PWA tab + Android app) who joined from one and then lost it —
    // sleeping laptop, force-quit — stayed in the Redis room hash for its full
    // 8h TTL: the room never emptied, `group_call:ended` never fired, every chat
    // member kept the "call in progress" banner and offers were routed to a
    // socket that is not in a call.
    const joinedRooms = new Set<string>()
    /** Consecutive JSON.parse failures — see MAX_INVALID_JSON_FRAMES. */
    let invalidJsonFrames = 0

    // Short-TTL block-status cache for high-frequency relay-audio frames.
    // isBlocked() is a DB query and relay frames arrive ~tens/sec per peer, so
    // an uncached check per frame is amplifiable DB load. The TTL keeps a
    // mid-call block near-real-time (takes effect within RELAY_BLOCK_TTL_MS).
    const RELAY_BLOCK_TTL_MS = 5_000
    const relayBlockCache = new Map<string, { blocked: boolean; at: number }>()
    const isRelayBlockedCached = async (senderId: string, targetId: string): Promise<boolean> => {
      const now = Date.now()
      const hit = relayBlockCache.get(targetId)
      if (hit && now - hit.at < RELAY_BLOCK_TTL_MS) return hit.blocked
      const blocked = await isBlocked(senderId, targetId)
      relayBlockCache.set(targetId, { blocked, at: now })
      return blocked
    }

    // FIX 1: Handle websocket errors to prevent ECONNRESET crashes
    ws.on('error', (err) => {
      request.log.error({ err, userId: authed?.id }, 'websocket error')
      try {
        ws.terminate()
      } catch {
        // Socket is already closing.
      }
    })

    // FIX 2: Mark connection alive for heartbeat
    const heartbeatWs = ws as HeartbeatSocket
    heartbeatWs.__isAlive = true
    ws.on('pong', () => {
      heartbeatWs.__isAlive = true
    })

    // Throttle for the per-frame session-revocation recheck below (#19): the
    // connect path already validated the session, so start the clock now and
    // recheck at most once per interval.
    let lastRevalidateAt = Date.now()
    const REVALIDATE_INTERVAL_MS = 15_000

    /** Handles a single parsed raw websocket frame for an authenticated user. */
    const handleMessage = (raw: unknown, user: AuthUser) => {
      void (async () => {
        const frameBytes = rawByteLength(raw)
        if (frameBytes > MAX_WS_MESSAGE_BYTES) {
          request.log.warn({ correlationId, userId: user.id }, 'ws: message exceeds max size')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'MESSAGE_TOO_LARGE' }))
          ws.close(1009, 'message too large')
          return
        }

        let json: unknown
        try {
          json = JSON.parse(bufferToString(raw))
          invalidJsonFrames = 0
        } catch {
          // This branch used to return BEFORE the rate limiter ran, which made
          // `{"` the cheapest completely UNLIMITED frame in the protocol: one
          // pino warn line + one error reply per frame, at link speed, across 12
          // sockets per account. Charge it to the control bucket like every
          // other frame, and hang up on a client that keeps it up.
          invalidJsonFrames += 1
          const withinBudget = rateLimiter.check({
            bucket: 'control',
            limit: WS_RATE_LIMIT_MAX,
          })
          if (!withinBudget || invalidJsonFrames >= MAX_INVALID_JSON_FRAMES) {
            request.log.warn({ correlationId, userId: user.id }, 'ws: invalid json frame flood')
            ws.close(1008, 'invalid json')
            return
          }
          request.log.warn({ correlationId, userId: user.id }, 'ws: invalid json frame')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'INVALID_JSON' }))
          return
        }

        if (!rateLimiter.check(resolveWsRateLimit(json, isInCall()))) {
          request.log.warn({ correlationId, userId: user.id }, 'ws: rate limit exceeded')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'RATE_LIMIT_EXCEEDED' }))
          return
        }

        // Session/device revocation must take effect on the realtime channel for
        // ANY frame, not only presence_ping — a client fully controls which frames
        // it sends and could simply never ping to dodge revocation (#19). Recheck
        // (throttled) before dispatching any frame; close 1008 on failure.
        {
          const now = Date.now()
          if (now - lastRevalidateAt >= REVALIDATE_INTERVAL_MS) {
            lastRevalidateAt = now
            if (sessionJti && (await isJtiDenied(sessionJti))) {
              safeSend(ws, JSON.stringify({ type: 'error', error: 'SESSION_REVOKED' }))
              ws.close(1008, 'session revoked')
              return
            }
            if (sessionDeviceId && !(await assertDeviceActiveForUser(user.id, sessionDeviceId))) {
              safeSend(ws, JSON.stringify({ type: 'error', error: 'DEVICE_REVOKED' }))
              ws.close(1008, 'device revoked')
              return
            }
          }
        }

        // chat_message frames are intentionally not accepted over WS — the
        // REST POST /messages/send path is the single source of truth and
        // enforces fan-out, channel-role, and DR-header validation that this
        // handler historically bypassed (audit 2026-05-03 A.P0 #2).
        if (
          json &&
          typeof json === 'object' &&
          (json as { type?: unknown }).type === 'chat_message'
        ) {
          safeSend(
            ws,
            JSON.stringify({ type: 'error', error: 'CHAT_MESSAGE_OVER_WS_FORBIDDEN' })
          )
          return
        }

        // Calls disabled for this instance (Lite self-host): reject call + WebRTC
        // signaling at the WS boundary so a calls-off server can't relay a ring or
        // a group-call join. featureFlags is decorated on the app in buildApp; the
        // REST /call and /turn route groups are also skipped, so no token/ICE
        // exists either. Full build defaults calls ON → this is a no-op there.
        if (!app.featureFlags.calls) {
          const mt = (json as { type?: unknown } | null)?.type
          if (
            typeof mt === 'string' &&
            (mt === 'webrtc_signal' || mt.startsWith('call_') || mt.startsWith('group_call'))
          ) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'FEATURE_DISABLED', feature: 'calls' }))
            return
          }
        }

        const rtcParsed = webrtcSignalSchema.safeParse(json)
        if (rtcParsed.success) {
          const { targetUserId, signalData } = rtcParsed.data
          const signalKind =
            signalData && typeof signalData === 'object'
              ? (signalData as { kind?: unknown }).kind
              : undefined

          // D14: Relay audio frames flow at ~20-30 fps/peer. Re-running the
          // (sender,target) shared-chat + block authorization on every frame
          // costs ~3 DB queries/frame and is trivially amplifiable. Resolve the
          // decision ONCE on the relay handshake (relay_offer/relay_answer) and
          // cache it for a short TTL; relay_frame frames consult the cache and
          // skip the DB entirely once authorized.
          const isRelayFrame = signalKind === 'relay_frame'
          const isRelayHandshake =
            signalKind === 'relay_offer' || signalKind === 'relay_answer'

          if (isRelayFrame) {
            // Bound the opaque blob before it is fan-out'd — see
            // MAX_RELAY_FRAME_BYTES. Checked on the raw frame so this costs
            // nothing on the 2400/min hot path.
            if (frameBytes > MAX_RELAY_FRAME_BYTES) {
              safeSend(ws, JSON.stringify({ type: 'error', error: 'MESSAGE_TOO_LARGE' }))
              return
            }
            const cached = getCachedCallAuth(user.id, targetUserId)
            if (cached === true) {
              // Authorized within TTL — skip per-frame DB work entirely.
              sendToUser(targetUserId, {
                type: 'webrtc_signal',
                fromUserId: user.id,
                signalData,
              })
              return
            }
            if (cached === false) {
              // A prior handshake within TTL was explicitly denied — drop.
              safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
              return
            }
            // No fresh cache entry (TTL lapsed or no handshake seen): fall
            // through to a full DB authorization, which also refreshes the
            // cache below.
          }

          // FIX 3: Verify sender and target share at least one chat
          const senderChats = await db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(eq(chatMembers.userId, user.id))
          const senderChatIds = senderChats.map((r) => r.chatId)
          if (senderChatIds.length === 0) {
            if (isRelayFrame || isRelayHandshake) {
              setCachedCallAuth(user.id, targetUserId, false)
            }
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NO_SHARED_CHAT' }))
            return
          }
          const [targetInShared] = await db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(
              and(
                eq(chatMembers.userId, targetUserId),
                inArray(chatMembers.chatId, senderChatIds)
              )
            )
            .limit(1)
          if (!targetInShared) {
            if (isRelayFrame || isRelayHandshake) {
              setCachedCallAuth(user.id, targetUserId, false)
            }
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NO_SHARED_CHAT' }))
            return
          }

          if (await isBlocked(user.id, targetUserId)) {
            if (isRelayFrame || isRelayHandshake) {
              setCachedCallAuth(user.id, targetUserId, false)
            }
            safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
            return
          }

          // Authorized. Cache the decision so the relay_frame fast-path above can
          // skip the DB for the rest of this signaling session.
          if (isRelayFrame || isRelayHandshake) {
            setCachedCallAuth(user.id, targetUserId, true)
            // #24: keep a LONG 1:1 call in the elevated tier. RENEW only — this
            // authorization is sender-driven (any member can emit a relay_offer
            // to a contact), so it must never be able to CREATE a grant, or a
            // client could pin itself into 2400/min without a call existing.
            refreshInCall()
            // ...but the CALLER only ever gets a bootstrap: `markInCall` fires on
            // call_accept and group_call:join, which only the CALLEE and room
            // joiners send. So 30s into every 1:1 call the dialler dropped to the
            // 60/min control bucket while streaming ~700 relay frames/min — its
            // outbound audio went silent mid-call and the rejected frames also
            // starved its presence/typing/read traffic.
            //
            // Promote on TWO-SIDED evidence: the peer has itself pushed an
            // authorized relay frame back at us, which only the peer's own socket
            // can cause. A lone client emitting relay_offer at a contact who never
            // answers still gets nothing but the expiring bootstrap, so the
            // anti-self-pinning property the split was built for is preserved.
            if (getCachedCallAuth(targetUserId, user.id) === true) {
              markInCall(IN_CALL_TTL_MS)
            }
          }

          // WARNING: This relay must stay opaque. Never introspect or mutate SDP/ICE fields,
          // otherwise zero-trust call signaling can be accidentally broken.
          sendToUser(targetUserId, {
            type: 'webrtc_signal',
            fromUserId: user.id,
            signalData,
          })
          request.log.debug(
            { correlationId, fromUserId: user.id, targetUserId },
            'ws: relayed webrtc_signal'
          )
          return
        }

        const inviteParsed = callInviteSchema.safeParse(json)
        if (inviteParsed.success) {
          const { chat_id, is_video } = inviteParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) {
            request.log.warn(
              { correlationId, chatId: chat_id, userId: user.id },
              'ws: not a member for call_invite'
            )
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }
          // FIX 10 + #29: Block check applies to EVERY recipient, groups too —
          // a blocked member must not be rung (or pushed), not just in 2-member
          // chats. Filter the fan-out/push target list by the block relationship.
          const memberIds = await getChatMemberIds(chat_id)
          const candidateIds = memberIds.filter((id) => id !== user.id)
          if (candidateIds.length > MAX_CALL_INVITE_MEMBERS) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'CHAT_TOO_LARGE_FOR_CALL' }))
            return
          }
          // ONE set query, not one SELECT per candidate — see filterOutBlocked.
          const otherIds = await filterOutBlocked(user.id, candidateIds)
          if (otherIds.length === 0) {
            // Everyone reachable is blocked (e.g. the only peer in a 1:1).
            safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
            return
          }
          // #24: the caller emits its relay_offer + ICE burst immediately after
          // this invite, so grant the elevated tier now — but only a SHORT,
          // NON-RENEWABLE bootstrap. An invite nobody answers decays back to
          // 60/min and can only be re-earned MAX_BOOTSTRAP_GRANTS times; the
          // full renewable TTL comes from an actual answer (call_accept below).
          markCallBootstrap()
          broadcastToUsers(otherIds, {
            type: 'call_invite',
            chat_id,
            from_user_id: user.id,
            is_video,
          })
          // Push notification for offline members
          const callerName = user.username
          // #26: cross-instance presence — a peer connected to ANOTHER api
          // instance must not be rung by push as if they were offline.
          const inviteOnline = await areOnline(otherIds)
          const invitePayload = {
            type: 'incoming_call' as const,
            title: is_video ? `📹 ${callerName}` : `📞 ${callerName}`,
            body: is_video ? 'Входящий видеозвонок' : 'Входящий голосовой звонок',
            url: `/?chat=${chat_id}`,
            icon: '/icon-192.png',
            chat_id,
            caller_name: callerName,
          }
          // BOTH transports, mirroring the chat-message path. A Capacitor build
          // short-circuits to native push, so those users have a row in
          // native_push_tokens and NONE in push_subscriptions: Web-Push-only meant
          // the phone simply never rang, while ordinary messages still arrived.
          const pushPromises = otherIds
            .filter((id) => !inviteOnline.get(id))
            .flatMap((id) => [
              sendPushToUser(id, invitePayload).catch((err) =>
                request.log.warn({ err, targetUserId: id }, 'ws: call_invite push failed')
              ),
              sendNativePushToUser(id, invitePayload).catch((err) =>
                request.log.warn({ err, targetUserId: id }, 'ws: call_invite native push failed')
              ),
            ])
          void Promise.allSettled(pushPromises)
          // C-2: track active call in Redis for missed-call detection (90s TTL).
          // Encode the invite timestamp alongside the video flag so call_leave can
          // require a real ring duration before logging a missed call (#31).
          const redis = getRedis()
          if (redis) {
            await redis.set(
              `call:active:${chat_id}:${user.id}`,
              `${is_video ? '1' : '0'}:${Date.now()}`,
              'EX',
              90
            )
          }
          return
        }

        const leaveParsed = callLeaveSchema.safeParse(json)
        if (leaveParsed.success) {
          const { chat_id } = leaveParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          // #24: hang-up ends the grant. Cleared unconditionally, BEFORE the
          // missed-call branch below which returns early on a short ring.
          clearInCall()
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'call_leave',
            chat_id,
            from_user_id: user.id,
          })
          // C-2: if caller leaves and nobody answered, insert missed-call system
          // message; if the call WAS answered (key rewritten by call_accept),
          // insert a call-ended event with the talk duration instead.
          const redis = getRedis()
          if (redis) {
            const redisKey = `call:active:${chat_id}:${user.id}`
            const activeVal = await redis.get(redisKey)
            if (activeVal !== null && activeVal.startsWith('answered:')) {
              // `answered:<videoFlag>:<acceptTs>` → the call connected; log the
              // duration. Only the CALLER's key exists, so exactly one event is
              // written no matter which side hangs up first.
              await redis.del(redisKey)
              const [, videoFlag, acceptTsStr] = activeVal.split(':')
              const isVideo = videoFlag === '1'
              const durationSecs = Math.max(
                0,
                Math.round((Date.now() - Number(acceptTsStr || Date.now())) / 1000)
              )
              await persistChatMessageAndFanOut({
                chatId: chat_id,
                senderId: user.id,
                content: JSON.stringify({
                  kind: 'call_ended',
                  is_video: isVideo,
                  duration_secs: durationSecs,
                }),
                iv: 'system:v1',
              })
              await db.insert(callSessions).values({
                chatId: chat_id,
                initiatedBy: user.id,
                callType: isVideo ? 'video' : 'audio',
                participantIds: [user.id],
                endReason: 'completed',
              }).catch(() => { /* non-fatal */ })
            } else if (activeVal !== null) {
              // key still exists → nobody answered
              await redis.del(redisKey)
              const [videoFlag, tsStr] = activeVal.split(':')
              const isVideo = videoFlag === '1'
              // Anti-spoof (#31): only log a missed call if the call actually rang
              // for a moment. A scripted call_invite→call_leave (well under a
              // second) must NOT inject a fake "missed call" into the timeline.
              // Legacy keys (no timestamp) default to "rang enough" so in-flight
              // calls across a deploy still log correctly.
              const rangMs = tsStr ? Date.now() - Number(tsStr) : 3000
              if (!(rangMs >= 3000)) {
                return
              }
              await persistChatMessageAndFanOut({
                chatId: chat_id,
                senderId: user.id,
                content: JSON.stringify({ kind: 'call_missed', is_video: isVideo }),
                iv: 'system:v1',
              })
              // C-7: log missed call session
              await db.insert(callSessions).values({
                chatId: chat_id,
                initiatedBy: user.id,
                callType: isVideo ? 'video' : 'audio',
                participantIds: [user.id],
                endReason: 'missed',
              }).catch(() => { /* non-fatal */ })
            }
          }
          return
        }

        const rejectParsed = callRejectSchema.safeParse(json)
        if (rejectParsed.success) {
          const { chat_id } = rejectParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          clearInCall() // #24: rejecting ends any elevated-tier grant.
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'call_reject',
            chat_id,
            from_user_id: user.id,
          })
          // C-7: log rejected call session (best-effort)
          await db.insert(callSessions).values({
            chatId: chat_id,
            initiatedBy: user.id,
            callType: 'audio',
            participantIds: [user.id],
            endReason: 'rejected',
          }).catch(() => { /* non-fatal */ })
          // Clear the caller's active-call key (mirrors call_accept). Otherwise
          // the caller's own client, on receiving call_reject, runs
          // severAllLinks -> call_leave; the server still sees the live key and
          // persists a spurious "missed call" message + a duplicate session row.
          const redis = getRedis()
          if (redis) {
            await Promise.all(
              otherIds.map((callerId) => redis.del(`call:active:${chat_id}:${callerId}`))
            )
          }
          return
        }

        const acceptParsed = callAcceptSchema.safeParse(json)
        if (acceptParsed.success) {
          const { chat_id } = acceptParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          // C-4: cancel the incoming-call modal on all OTHER devices of this user
          broadcastToUsers([user.id], {
            type: 'call_cancel_on_other_devices',
            chat_id,
          })
          // The call was answered: rewrite the caller's ringing key into an
          // `answered:<videoFlag>:<acceptTs>` marker (instead of deleting it)
          // so the caller's eventual call_leave logs a call-ended event with
          // the talk duration. 12h TTL bounds a crash-orphaned key.
          const redis = getRedis()
          let hadRingingCall = false
          if (redis) {
            const members = await getChatMemberIds(chat_id)
            const callerIds = members.filter((id) => id !== user.id)
            const results = await Promise.all(
              callerIds.map(async (callerId) => {
                const key = `call:active:${chat_id}:${callerId}`
                const val = await redis.get(key)
                if (val === null || val.startsWith('answered:')) return false
                const videoFlag = val.split(':')[0] === '1' ? '1' : '0'
                await redis.set(key, `answered:${videoFlag}:${Date.now()}`, 'EX', 43200)
                return true
              })
            )
            hadRingingCall = results.some(Boolean)
          }
          // #24: only answering a call that was REALLY ringing grants the full
          // elevated tier — otherwise any chat member could self-elevate by
          // sending call_accept into a silent chat. With no Redis we cannot
          // verify, so grant rather than break calls on such a deployment.
          if (!redis || hadRingingCall) markInCall(IN_CALL_TTL_MS)
          return
        }

        const reactionParsed = toggleReactionSchema.safeParse(json)
        if (reactionParsed.success) {
          const { message_id, chat_id, emoji } = reactionParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }
          const [msg] = await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.id, message_id), eq(messages.chatId, chat_id)))
            .limit(1)
          if (!msg) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'MESSAGE_NOT_FOUND' }))
            return
          }

          const reactions = await db.transaction(async (tx) => {
            const [existing] = await tx
              .select({ messageId: messageReactions.messageId })
              .from(messageReactions)
              .where(
                and(
                  eq(messageReactions.messageId, message_id),
                  eq(messageReactions.userId, user.id),
                  eq(messageReactions.emoji, emoji)
                )
              )
              .limit(1)
            if (existing) {
              await tx
                .delete(messageReactions)
                .where(
                  and(
                    eq(messageReactions.messageId, message_id),
                    eq(messageReactions.userId, user.id),
                    eq(messageReactions.emoji, emoji)
                  )
                )
            } else {
              await tx
                .insert(messageReactions)
                .values({ messageId: message_id, userId: user.id, emoji })
                .onConflictDoNothing()
            }
            const reactionRows = await tx
              .select({ userId: messageReactions.userId, emoji: messageReactions.emoji })
              .from(messageReactions)
              .where(eq(messageReactions.messageId, message_id))
            const out: Record<string, string[]> = {}
            for (const r of reactionRows) {
              ;(out[r.emoji] ??= []).push(r.userId)
            }
            return out
          })

          const memberIds = await getChatMemberIds(chat_id)
          broadcastToUsers(memberIds, {
            type: 'reaction_update',
            message_id,
            chat_id,
            reactions,
          })
          return
        }

        const readParsed = messageReadSchema.safeParse(json)
        if (readParsed.success) {
          const { chat_id, message_id } = readParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          void markMessageReadByReader(user.id, message_id, chat_id).catch(err => request.log.error(err, 'mark read failed'))
          return
        }

        const pingParsed = presencePingSchema.safeParse(json)
        if (pingParsed.success) {
          // Revalidate session on each heartbeat: check JTI denylist + device revocation
          if (sessionJti && await isJtiDenied(sessionJti)) {
            request.log.info({ correlationId, userId: user.id }, 'ws: session revoked (JTI denied)')
            safeSend(ws, JSON.stringify({ type: 'error', error: 'SESSION_REVOKED' }))
            ws.close(1008, 'session revoked')
            return
          }
          if (sessionDeviceId) {
            const deviceOk = await assertDeviceActiveForUser(user.id, sessionDeviceId)
            if (!deviceOk) {
              request.log.info({ correlationId, userId: user.id }, 'ws: device revoked')
              safeSend(ws, JSON.stringify({ type: 'error', error: 'DEVICE_REVOKED' }))
              ws.close(1008, 'device revoked')
              return
            }
          }
          // MUST have a terminal handler. index.ts escalates any
          // unhandledRejection to a full process shutdown, so this detached
          // best-effort DB write was a whole-API kill switch: during a brief
          // Postgres blip (restart, failover, pool exhaustion) the first
          // heartbeat ping to reject would take down every other user's socket,
          // call and in-flight upload with it — and reconnecting clients ping
          // again immediately, so it re-crashed for as long as the blip lasted.
          // The sibling read-receipt write 20 lines up already guards itself.
          void touchLastSeenPing(user.id).catch((err) =>
            request.log.warn({ err: String(err), userId: user.id }, 'ws: last-seen ping failed')
          )
          return
        }

        const typingStartParsed = typingStartSchema.safeParse(json)
        if (typingStartParsed.success) {
          const { chat_id } = typingStartParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'typing_start',
            chat_id,
            user_id: user.id,
            username: user.username,
          })
          return
        }

        const typingStopParsed = typingStopSchema.safeParse(json)
        if (typingStopParsed.success) {
          const { chat_id } = typingStopParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'typing_stop',
            chat_id,
            user_id: user.id,
            username: user.username,
          })
          return
        }

        // --- GROUP CALL SIGNALING ---
        const gcJoin = groupCallJoinSchema.safeParse(json)
        if (gcJoin.success) {
          const { room_id } = gcJoin.data
          if (!(await isMemberOfChat(room_id, user.id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }
          const participants = await joinRoom(room_id, user.id, user.username)
          // Bind the room to THIS socket so its close handler can release it —
          // see `joinedRooms`.
          joinedRooms.add(room_id)
          // #24: the server itself just put this user in the room — authoritative
          // proof of an in-call connection, so grant the full elevated tier.
          markInCall(IN_CALL_TTL_MS)
          // Send current participant list to the joiner
          sendToUser(user.id, {
            type: 'group_call:participant_list',
            room_id,
            participants,
          })
          // Notify all other room participants that someone joined
          const otherIds = (await getRoomParticipantIds(room_id)).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:member_join',
            room_id,
            user_id: user.id,
            username: user.username,
          })
          // Also broadcast to all chat members that a call is active
          const chatMemberIds = await getChatMemberIds(room_id)
          const roomIds = new Set(await getRoomParticipantIds(room_id))
          const nonCallMembers = chatMemberIds.filter(id => !roomIds.has(id))
          broadcastToUsers(nonCallMembers, {
            type: 'group_call:active',
            room_id,
            participant_count: participants.length,
          })
          // When the call has JUST started (this is the first participant), also
          // push the OFFLINE chat members so people can be pulled into a group call
          // even when they aren't currently connected (issue #4). Mirrors the 1:1
          // call_invite offline push above.
          if (participants.length === 1) {
            const groupOnline = await areOnline(nonCallMembers)
            const groupPayload = {
              type: 'message' as const,
              title: `📞 ${user.username}`,
              body: 'Звонок в группе — откройте, чтобы присоединиться',
              url: `/?chat=${room_id}`,
              icon: '/icon-192.png',
              chat_id: room_id,
            }
            // BOTH transports — Capacitor users only have an FCM token, so a
            // Web-Push-only fan-out never reached them (same gap as call_invite).
            const groupPush = nonCallMembers
              .filter((id) => !groupOnline.get(id))
              .flatMap((id) => [
                sendPushToUser(id, groupPayload).catch((err) =>
                  request.log.warn({ err, targetUserId: id }, 'ws: group_call push failed')
                ),
                sendNativePushToUser(id, groupPayload).catch((err) =>
                  request.log.warn({ err, targetUserId: id }, 'ws: group_call native push failed')
                ),
              ])
            void Promise.allSettled(groupPush)
          }
          return
        }

        const gcLeave = groupCallLeaveSchema.safeParse(json)
        if (gcLeave.success) {
          const { room_id } = gcLeave.data
          clearInCall() // #24: left the room — drop back to the control tier.
          joinedRooms.delete(room_id)
          // This frame TEARS DOWN shared state — it deletes `call:session:<room>`
          // (rotating the room's E2EE key) and broadcasts group_call:ended to
          // every chat member. It was the only group_call frame with no gate at
          // all, so anyone who merely knew a chat uuid could end an in-progress
          // call and leave the next joiner with a different room key. Gate on
          // actual participation, like every other group_call frame does — NOT on
          // chat membership, so someone removed from the chat mid-call can still
          // hang up cleanly.
          if (!(await isUserInRoom(room_id, user.id))) return
          const remaining = await leaveRoom(room_id, user.id)
          const otherIds = remaining.map(p => p.userId)
          broadcastToUsers(otherIds, {
            type: 'group_call:member_leave',
            room_id,
            user_id: user.id,
          })
          // Notify chat members about updated call state
          if (remaining.length === 0) {
            // The call ended (room empty) — drop the per-call E2EE session id so
            // the NEXT call in this room derives a fresh LiveKit room key.
            // Otherwise the key persists for its 8h Redis TTL and a former member
            // who cached it could decrypt a later call in the same room (the
            // forward-secrecy the call/token comment promises).
            const redis = getRedis()
            if (redis) {
              try { await redis.del(`call:session:${room_id}`) } catch { /* best-effort */ }
            }
            const chatMemberIds = await getChatMemberIds(room_id)
            broadcastToUsers(chatMemberIds, {
              type: 'group_call:ended',
              room_id,
            })
          } else {
            const chatMemberIds = await getChatMemberIds(room_id)
            const remainingIds = new Set(remaining.map(p => p.userId))
            const nonCallMembers = chatMemberIds.filter(id => !remainingIds.has(id))
            broadcastToUsers(nonCallMembers, {
              type: 'group_call:active',
              room_id,
              participant_count: remaining.length,
            })
          }
          return
        }

        const gcOffer = groupCallOfferSchema.safeParse(json)
        if (gcOffer.success) {
          const { room_id, target_user_id, sdp, is_video } = gcOffer.data
          if (!(await isUserInRoomTracked(room_id, user.id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_IN_CALL' }))
            return
          }
          if (!(await ensureGroupCallTargetInRoom(room_id, target_user_id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'TARGET_NOT_IN_CALL' }))
            return
          }
          if (await isBlocked(user.id, target_user_id)) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
            return
          }
          sendToUser(target_user_id, {
            type: 'group_call:offer',
            room_id,
            from_user_id: user.id,
            sdp,
            is_video,
          })
          return
        }

        const gcAnswer = groupCallAnswerSchema.safeParse(json)
        if (gcAnswer.success) {
          const { room_id, target_user_id, sdp } = gcAnswer.data
          if (!(await isUserInRoomTracked(room_id, user.id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_IN_CALL' }))
            return
          }
          if (!(await ensureGroupCallTargetInRoom(room_id, target_user_id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'TARGET_NOT_IN_CALL' }))
            return
          }
          if (await isBlocked(user.id, target_user_id)) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
            return
          }
          sendToUser(target_user_id, {
            type: 'group_call:answer',
            room_id,
            from_user_id: user.id,
            sdp,
          })
          return
        }

        const gcIce = groupCallIceSchema.safeParse(json)
        if (gcIce.success) {
          const { room_id, target_user_id, candidate } = gcIce.data
          if (!(await isUserInRoomTracked(room_id, user.id))) return
          if (!(await ensureGroupCallTargetInRoom(room_id, target_user_id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'TARGET_NOT_IN_CALL' }))
            return
          }
          if (await isBlocked(user.id, target_user_id)) return
          sendToUser(target_user_id, {
            type: 'group_call:ice',
            room_id,
            from_user_id: user.id,
            candidate,
          })
          return
        }

        const gcMute = groupCallMuteSchema.safeParse(json)
        if (gcMute.success) {
          const { room_id, is_muted } = gcMute.data
          if (!(await isUserInRoomTracked(room_id, user.id))) return
          await updateParticipantState(room_id, user.id, { isMuted: is_muted })
          const otherIds = (await getRoomParticipantIds(room_id)).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:mute',
            room_id,
            user_id: user.id,
            is_muted,
          })
          return
        }

        const gcVideo = groupCallVideoToggleSchema.safeParse(json)
        if (gcVideo.success) {
          const { room_id, is_video_off } = gcVideo.data
          if (!(await isUserInRoomTracked(room_id, user.id))) return
          await updateParticipantState(room_id, user.id, { isVideoOff: is_video_off })
          const otherIds = (await getRoomParticipantIds(room_id)).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:video_toggle',
            room_id,
            user_id: user.id,
            is_video_off,
          })
          return
        }

        const gcSpeaking = groupCallSpeakingSchema.safeParse(json)
        if (gcSpeaking.success) {
          const { room_id, is_speaking } = gcSpeaking.data
          if (!(await isUserInRoomTracked(room_id, user.id))) return
          const otherIds = (await getRoomParticipantIds(room_id)).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:speaking',
            room_id,
            user_id: user.id,
            is_speaking,
          })
          return
        }

        const gcRelayFrame = groupCallRelayFrameSchema.safeParse(json)
        if (gcRelayFrame.success) {
          const { room_id, target_user_id, ciphertext, iv, sample_rate, seq } = gcRelayFrame.data
          if (!(await isUserInRoomTracked(room_id, user.id))) return
          if (!(await ensureGroupCallTargetInRoom(room_id, target_user_id))) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'TARGET_NOT_IN_CALL' }))
            return
          }
          // High-frequency audio frames: drop silently when blocked (no error
          // flood). Mirrors the block boundary the 1:1 webrtc_signal enforces.
          // Cached (short TTL) so it isn't a DB query on every relay frame.
          if (await isRelayBlockedCached(user.id, target_user_id)) return
          sendToUser(target_user_id, {
            type: 'group_call:relay_frame',
            room_id,
            from_user_id: user.id,
            ciphertext,
            iv,
            sample_rate,
            seq,
          })
          return
        }

        safeSend(ws, JSON.stringify({ type: 'error', error: 'UNKNOWN_MESSAGE_TYPE' }))
      })().catch((err) => {
        request.log.error({ correlationId, userId: user.id, err: String(err) }, 'ws: unhandled error in message handler')
      })
    }

    // Release THIS socket's group-call rooms when it closes. The registry's
    // last-socket-closed callback below is only a backstop: it never fires while
    // any other socket of the same user is still open, so a second device kept
    // the dropped one's room membership alive for the room's 8h TTL (ghost
    // participant → the room never empties → no group_call:ended → a permanent
    // "call in progress" banner, and offers routed to a socket not in a call).
    ws.on('close', () => {
      if (joinedRooms.size === 0) return
      const rooms = [...joinedRooms]
      joinedRooms.clear()
      const uid = authed?.id
      if (!uid) return
      // Room membership is keyed per USER, not per socket (`group-call:room:{id}`
      // is a HASH userId -> participant), so releasing it from one socket's close
      // ejects the user outright even though they are still connected. That turns
      // an ordinary WiFi→LTE reconnect — the client is back in ~2s, long before
      // the 30s heartbeat reaps the dead socket — into: frames silently dropped,
      // clearInCall() back to 60/min, peers told member_leave, and the room key
      // rotated under the survivor if they were last. The user's UI still shows
      // an active call with no error and no way back in, because nothing rejoins.
      //
      // Defer to the registry's last-socket-closed `leaveAllRooms` whenever the
      // user still holds a socket. That callback is the authoritative release and
      // by contract only fires when the last one goes.
      if (hasActiveSocket(uid)) return
      void (async () => {
        for (const roomId of rooms) {
          const remaining = await leaveRoom(roomId, uid)
          broadcastToUsers(remaining.map((p) => p.userId), {
            type: 'group_call:member_leave',
            room_id: roomId,
            user_id: uid,
          })
          if (remaining.length === 0) {
            // Room emptied — same forward-secrecy rotation gcLeave performs.
            const redis = getRedis()
            if (redis) {
              try { await redis.del(`call:session:${roomId}`) } catch { /* best-effort */ }
            }
            broadcastToUsers(await getChatMemberIds(roomId), {
              type: 'group_call:ended',
              room_id: roomId,
            })
          }
        }
      })().catch((err) => {
        // index.ts escalates unhandledRejection to a full process shutdown, so a
        // transient Redis/DB error here must not leave the promise unguarded.
        request.log.error({ err: String(err), userId: uid }, 'ws: socket-close room cleanup failed')
      })
    })

    ws.on('message', (raw) => {
      if (!authed) {
        if (pending.length < MAX_PENDING) pending.push(raw)
        return
      }
      handleMessage(raw, authed)
    })

    void resolveWsUser(request).then(async (result) => {
      if (!result) {
        request.log.warn({ correlationId }, 'ws: unauthorized upgrade')
        ws.close(1008, 'unauthorized')
        return
      }
      const user = result.user
      authed = user
      sessionJti = result.jti
      sessionDeviceId = result.device_id
      // #26: evaluated BEFORE registerUserSocket claims presence below. Asking
      // across instances also stops a 2nd tab landing on another instance from
      // re-broadcasting a redundant online:true to every peer.
      const wasOnline = await isOnline(user.id)
      const lastSeenIso = await touchLastSeen(user.id)
      registerUserSocket(user.id, ws, (uid) => {
        clearPingWriteAt(uid)
        void (async () => {
          // Clean up group call rooms when user's last socket closes
          const leftRooms = await leaveAllRooms(uid)
          for (const [roomId, remaining] of leftRooms) {
            const otherIds = remaining.map(p => p.userId)
            broadcastToUsers(otherIds, {
              type: 'group_call:member_leave',
              room_id: roomId,
              user_id: uid,
            })
            if (remaining.length === 0) {
              const chatMemberIds = await getChatMemberIds(roomId)
              broadcastToUsers(chatMemberIds, {
                type: 'group_call:ended',
                room_id: roomId,
              })
            }
          }

          // #26: this fires when THIS instance's last socket for the user
          // closes — but another instance may still hold live sockets, in which
          // case announcing "offline" is simply false (and it would also mark
          // them push-eligible while they are actively connected). The registry
          // already released this instance's presence claim before invoking us,
          // so a true answer here means someone else genuinely still has them.
          if (await isOnline(uid)) return
          const iso = await touchLastSeen(uid)
          const peers = await getRelatedUserIds(uid)
          await broadcastOnlineStatusChange(peers, {
            user_id: uid,
            online: false,
            last_seen_at: iso,
          })
        })().catch((err) => {
          // A transient DB/Redis error in last-socket-close cleanup must not
          // become an unhandledRejection — index.ts treats those as fatal and
          // shuts the whole server down, dropping every other user's socket.
          request.log.error({ err: String(err) }, 'ws: last-socket-close cleanup failed')
        })
      })
      if (!wasOnline) {
        // Only resolve related users when we'll actually emit an online:true
        // broadcast — extra tabs / reconnects-while-online skip these queries.
        const related = await getRelatedUserIds(user.id)
        await broadcastOnlineStatusChange(related, {
          user_id: user.id,
          online: true,
          last_seen_at: lastSeenIso,
        })
      }
      request.log.info({ correlationId, userId: user.id }, 'ws: connected')

      // On connect, surface any group call already active in one of the user's
      // chats so they get the JOIN banner immediately — e.g. after tapping the
      // offline push for a call that started while they were away (issue #4).
      void (async () => {
        try {
          const myChatIds = await getUserChatIds(user.id)
          // Fan the per-chat room lookups out concurrently instead of awaiting
          // one Redis round-trip per chat serially (#46) — a user in many chats
          // otherwise pays N sequential round-trips on every (re)connect.
          const rooms = await Promise.all(
            myChatIds.map(async (chatId) => ({ chatId, ids: await getRoomParticipantIds(chatId) }))
          )
          for (const { chatId, ids } of rooms) {
            if (ids.length > 0 && !ids.includes(user.id)) {
              sendToUser(user.id, {
                type: 'group_call:active',
                room_id: chatId,
                participant_count: ids.length,
              })
            }
          }
        } catch (err) {
          request.log.warn({ err: String(err), userId: user.id }, 'ws: active-call-on-connect scan failed')
        }
      })()

      for (const raw of pending) {
        handleMessage(raw, user)
      }
      pending.length = 0
    }).catch((err) => {
      // The connect chain awaits DB/Redis (touchLastSeen, related-users,
      // online-status broadcast); a transient failure here must not bubble to
      // the process-level unhandledRejection handler, which shuts the whole
      // server down. Log and close just this socket instead.
      request.log.error({ correlationId, err: String(err) }, 'ws: connect failed')
      try {
        ws.close(1011, 'server error')
      } catch {
        /* socket already closed */
      }
    })
  })
}

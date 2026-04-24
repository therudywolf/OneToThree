import { and, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, messageReactions, messages, users } from '../db/schema.js'
import {
  getAuthUser,
  isUserDeviceSessionValid,
  assertDeviceActiveForUser,
  type AuthUser,
} from '../lib/auth-user.js'
import { isJtiDenied } from '../lib/jwt-denylist.js'
import { normalizeUuid } from '../lib/uuid.js'
import { markMessageReadByReader } from '../lib/mark-message-read.js'
import { parseOptionalBurnAt } from '../lib/burn-at.js'
import { persistChatMessageAndFanOut } from '../lib/chat-message-persist.js'
import { resolveMediaOriginalBytes } from '../lib/message-send-helpers.js'
import {
  broadcastOnlineStatusChange,
  clearPingWriteAt,
  getRelatedUserIds,
  touchLastSeen,
  touchLastSeenPing,
} from '../lib/presence.js'
import { isBlocked } from '../lib/block-check.js'
import {
  broadcastToUsers,
  hasActiveSocket,
  registerUserSocket,
  sendToUser,
} from '../ws/registry.js'
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
      },
      jti: p.jti,
      device_id: p.device_id,
    }
  } catch {
    return null
  }
}

const chatMessageInSchema = z.object({
  type: z.literal('chat_message'),
  chat_id: z.string().uuid(),
  content: z.string().nullable().optional(),
  iv: z.string().nullable().optional(),
  media_path: z.string().nullable().optional(),
  media_type: z.string().nullable().optional(),
  media_iv: z.string().nullable().optional(),
  reply_to_id: z.string().uuid().nullable().optional(),
  media_original_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  burn_at: z.string().nullable().optional(),
  protocol_version: z.union([z.literal(1), z.literal(2)]).optional(),
  dr_header: z.string().min(1).max(4096).nullable().optional(),
  dr_init: z.string().min(1).max(8192).nullable().optional(),
})

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
const MAX_WS_MESSAGE_BYTES = 64 * 1024

/** Per-connection rate limit: max messages per window. */
const WS_RATE_LIMIT_MAX = 60
const WS_RATE_LIMIT_RELAY_MAX = 2400
const WS_RATE_LIMIT_WINDOW_MS = 60_000

/** Simple sliding-window rate limiter per WebSocket connection. */
class WsRateLimiter {
  private timestamps: number[] = []

  check(limit = WS_RATE_LIMIT_MAX): boolean {
    const now = Date.now()
    const cutoff = now - WS_RATE_LIMIT_WINDOW_MS
    this.timestamps = this.timestamps.filter((t) => t > cutoff)
    if (this.timestamps.length >= limit) return false
    this.timestamps.push(now)
    return true
  }
}

function resolveWsRateLimit(json: unknown): number {
  if (!json || typeof json !== 'object') return WS_RATE_LIMIT_MAX
  const entry = json as {
    type?: unknown
    signalData?: { kind?: unknown } | null
  }
  if (entry.type === 'webrtc_signal' && entry.signalData?.kind === 'relay_frame') {
    return WS_RATE_LIMIT_RELAY_MAX
  }
  return WS_RATE_LIMIT_MAX
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

    /** Handles a single parsed raw websocket frame for an authenticated user. */
    const handleMessage = (raw: unknown, user: AuthUser) => {
      void (async () => {
        if (rawByteLength(raw) > MAX_WS_MESSAGE_BYTES) {
          request.log.warn({ correlationId, userId: user.id }, 'ws: message exceeds max size')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'MESSAGE_TOO_LARGE' }))
          ws.close(1009, 'message too large')
          return
        }

        let json: unknown
        try {
          json = JSON.parse(bufferToString(raw))
        } catch {
          request.log.warn({ correlationId, userId: user.id }, 'ws: invalid json frame')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'INVALID_JSON' }))
          return
        }

        if (!rateLimiter.check(resolveWsRateLimit(json))) {
          request.log.warn({ correlationId, userId: user.id }, 'ws: rate limit exceeded')
          safeSend(ws, JSON.stringify({ type: 'error', error: 'RATE_LIMIT_EXCEEDED' }))
          return
        }

        const chatParsed = chatMessageInSchema.safeParse(json)
        if (chatParsed.success) {
          const p = chatParsed.data
          if (!(await isMemberOfChat(p.chat_id, user.id))) {
            request.log.warn(
              { correlationId, chatId: p.chat_id, userId: user.id },
              'ws: not a member for chat_message'
            )
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }

          // In direct chats, enforce block check against the other member
          const memberIds = await getChatMemberIds(p.chat_id)
          if (memberIds.length === 2) {
            const peerId = memberIds.find((id) => id !== user.id)
            if (peerId && await isBlocked(user.id, peerId)) {
              safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
              return
            }
          }

          const burn = parseOptionalBurnAt(p.burn_at ?? null)
          if (!burn.ok) {
            safeSend(ws, JSON.stringify({ type: 'error', error: burn.error }))
            return
          }

          const persisted = await persistChatMessageAndFanOut({
            chatId: p.chat_id,
            senderId: user.id,
            replyToId: p.reply_to_id ?? null,
            content: p.content ?? null,
            iv: p.iv ?? null,
            mediaPath: p.media_path ?? null,
            mediaType: p.media_type ?? null,
            mediaIv: p.media_iv ?? null,
            mediaOriginalBytes: resolveMediaOriginalBytes(
              p.media_path ?? null,
              p.media_original_bytes
            ),
            burnAt: burn.date,
            protocolVersion: p.protocol_version ?? 1,
            drHeader: p.dr_header ?? null,
            drInit: p.dr_init ?? null,
          })

          if (!persisted.ok) {
            request.log.error(
              { correlationId, chatId: p.chat_id, userId: user.id },
              'ws: insert failed for chat_message'
            )
            safeSend(ws, JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }))
            return
          }
          return
        }

        const rtcParsed = webrtcSignalSchema.safeParse(json)
        if (rtcParsed.success) {
          const { targetUserId, signalData } = rtcParsed.data

          // FIX 3: Verify sender and target share at least one chat
          const senderChats = await db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(eq(chatMembers.userId, user.id))
          const senderChatIds = senderChats.map((r) => r.chatId)
          if (senderChatIds.length === 0) {
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
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NO_SHARED_CHAT' }))
            return
          }

          if (await isBlocked(user.id, targetUserId)) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
            return
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
          // FIX 10: Block check — blocked users cannot call
          const memberIds = await getChatMemberIds(chat_id)
          if (memberIds.length === 2) {
            const peerId = memberIds.find((id) => id !== user.id)
            if (peerId && await isBlocked(user.id, peerId)) {
              safeSend(ws, JSON.stringify({ type: 'error', error: 'BLOCKED' }))
              return
            }
          }
          const otherIds = memberIds.filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'call_invite',
            chat_id,
            from_user_id: user.id,
            is_video,
          })
          return
        }

        const leaveParsed = callLeaveSchema.safeParse(json)
        if (leaveParsed.success) {
          const { chat_id } = leaveParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'call_leave',
            chat_id,
            from_user_id: user.id,
          })
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
          void touchLastSeenPing(user.id)
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
          const participants = joinRoom(room_id, user.id, user.username)
          // Send current participant list to the joiner
          sendToUser(user.id, {
            type: 'group_call:participant_list',
            room_id,
            participants,
          })
          // Notify all other room participants that someone joined
          const otherIds = getRoomParticipantIds(room_id).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:member_join',
            room_id,
            user_id: user.id,
            username: user.username,
          })
          // Also broadcast to all chat members that a call is active
          const chatMemberIds = await getChatMemberIds(room_id)
          const nonCallMembers = chatMemberIds.filter(id => !isUserInRoom(room_id, id))
          broadcastToUsers(nonCallMembers, {
            type: 'group_call:active',
            room_id,
            participant_count: participants.length,
          })
          return
        }

        const gcLeave = groupCallLeaveSchema.safeParse(json)
        if (gcLeave.success) {
          const { room_id } = gcLeave.data
          const remaining = leaveRoom(room_id, user.id)
          const otherIds = remaining.map(p => p.userId)
          broadcastToUsers(otherIds, {
            type: 'group_call:member_leave',
            room_id,
            user_id: user.id,
          })
          // Notify chat members about updated call state
          if (remaining.length === 0) {
            const chatMemberIds = await getChatMemberIds(room_id)
            broadcastToUsers(chatMemberIds, {
              type: 'group_call:ended',
              room_id,
            })
          } else {
            const chatMemberIds = await getChatMemberIds(room_id)
            const nonCallMembers = chatMemberIds.filter(id => !isUserInRoom(room_id, id))
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
          if (!isUserInRoom(room_id, user.id)) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_IN_CALL' }))
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
          if (!isUserInRoom(room_id, user.id)) {
            safeSend(ws, JSON.stringify({ type: 'error', error: 'NOT_IN_CALL' }))
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
          if (!isUserInRoom(room_id, user.id)) return
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
          if (!isUserInRoom(room_id, user.id)) return
          updateParticipantState(room_id, user.id, { isMuted: is_muted })
          const otherIds = getRoomParticipantIds(room_id).filter(id => id !== user.id)
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
          if (!isUserInRoom(room_id, user.id)) return
          updateParticipantState(room_id, user.id, { isVideoOff: is_video_off })
          const otherIds = getRoomParticipantIds(room_id).filter(id => id !== user.id)
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
          if (!isUserInRoom(room_id, user.id)) return
          const otherIds = getRoomParticipantIds(room_id).filter(id => id !== user.id)
          broadcastToUsers(otherIds, {
            type: 'group_call:speaking',
            room_id,
            user_id: user.id,
            is_speaking,
          })
          return
        }

        safeSend(ws, JSON.stringify({ type: 'error', error: 'UNKNOWN_MESSAGE_TYPE' }))
      })().catch((err) => {
        request.log.error({ correlationId, userId: user.id, err: String(err) }, 'ws: unhandled error in message handler')
      })
    }

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
      const wasOnline = hasActiveSocket(user.id)
      const lastSeenIso = await touchLastSeen(user.id)
      const related = await getRelatedUserIds(user.id)
      registerUserSocket(user.id, ws, (uid) => {
        clearPingWriteAt(uid)
        void (async () => {
          // Clean up group call rooms when user's last socket closes
          const leftRooms = leaveAllRooms(uid)
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

          const iso = await touchLastSeen(uid)
          const peers = await getRelatedUserIds(uid)
          await broadcastOnlineStatusChange(peers, {
            user_id: uid,
            online: false,
            last_seen_at: iso,
          })
        })()
      })
      if (!wasOnline) {
        await broadcastOnlineStatusChange(related, {
          user_id: user.id,
          online: true,
          last_seen_at: lastSeenIso,
        })
      }
      request.log.info({ correlationId, userId: user.id }, 'ws: connected')
      for (const raw of pending) {
        handleMessage(raw, user)
      }
      pending.length = 0
    })
  })
}

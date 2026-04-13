import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, users } from '../db/schema.js'
import {
  getAuthUser,
  isUserDeviceSessionValid,
  type AuthUser,
} from '../lib/auth-user.js'
import { normalizeUuid } from '../lib/uuid.js'
import { markMessageReadByReader } from '../lib/mark-message-read.js'
import { parseOptionalBurnAt } from '../lib/burn-at.js'
import { persistChatMessageAndFanOut } from '../lib/chat-message-persist.js'
import { resolveMediaOriginalBytes } from '../lib/message-send-helpers.js'
import {
  broadcastOnlineStatusChange,
  getRelatedUserIds,
  touchLastSeen,
  touchLastSeenPing,
} from '../lib/presence.js'
import {
  broadcastToUsers,
  hasActiveSocket,
  registerUserSocket,
  sendToUser,
} from '../ws/registry.js'

/**
 * Resolves authenticated websocket user from session cookie or ws ticket JWT.
 * The ticket path is used when the browser does not include cookies during WS upgrade.
 */
async function resolveWsUser(request: FastifyRequest): Promise<AuthUser | null> {
  const fromCookie = await getAuthUser(request)
  if (fromCookie) return fromCookie
  const q = request.query as { ticket?: string }
  const ticket = q?.ticket?.trim()
  if (!ticket) return null
  try {
    const p = await request.server.jwt.verify<{
      sub: string
      username: string
      scope?: string
      device_id?: string
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
      id: normalizeUuid(row.id),
      username: row.username,
      is_discoverable: row.isDiscoverable,
      role: row.role === 'admin' ? 'admin' : 'user',
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

/** Maximum allowed WebSocket message size (1 MB). */
const MAX_WS_MESSAGE_BYTES = 1024 * 1024

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
  app.get('/ws', { websocket: true }, (ws: WebSocket, request) => {
    const correlationId = randomUUID()
    const pending: unknown[] = []
    let authed: AuthUser | null = null

    /** Handles a single parsed raw websocket frame for an authenticated user. */
    const handleMessage = (raw: unknown, user: AuthUser) => {
      void (async () => {
        if (rawByteLength(raw) > MAX_WS_MESSAGE_BYTES) {
          request.log.warn({ correlationId, userId: user.id }, 'ws: message exceeds max size')
          ws.send(JSON.stringify({ type: 'error', error: 'MESSAGE_TOO_LARGE' }))
          ws.close(1009, 'message too large')
          return
        }

        let json: unknown
        try {
          json = JSON.parse(bufferToString(raw))
        } catch {
          request.log.warn({ correlationId, userId: user.id }, 'ws: invalid json frame')
          ws.send(JSON.stringify({ type: 'error', error: 'INVALID_JSON' }))
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
            ws.send(JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }

          const burn = parseOptionalBurnAt(p.burn_at ?? null)
          if (!burn.ok) {
            ws.send(JSON.stringify({ type: 'error', error: burn.error }))
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
          })

          if (!persisted.ok) {
            request.log.error(
              { correlationId, chatId: p.chat_id, userId: user.id },
              'ws: insert failed for chat_message'
            )
            ws.send(JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }))
            return
          }
          return
        }

        const rtcParsed = webrtcSignalSchema.safeParse(json)
        if (rtcParsed.success) {
          const { targetUserId, signalData } = rtcParsed.data
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
            ws.send(JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }
          const otherIds = (await getChatMemberIds(chat_id)).filter(
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

        const readParsed = messageReadSchema.safeParse(json)
        if (readParsed.success) {
          const { chat_id, message_id } = readParsed.data
          if (!(await isMemberOfChat(chat_id, user.id))) return
          void markMessageReadByReader(user.id, message_id, chat_id)
          return
        }

        const pingParsed = presencePingSchema.safeParse(json)
        if (pingParsed.success) {
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

        ws.send(JSON.stringify({ type: 'error', error: 'UNKNOWN_MESSAGE_TYPE' }))
      })().catch((err) => {
        request.log.error({ correlationId, userId: user.id, err: String(err) }, 'ws: unhandled error in message handler')
      })
    }

    ws.on('message', (raw) => {
      if (!authed) {
        pending.push(raw)
        return
      }
      handleMessage(raw, authed)
    })

    void resolveWsUser(request).then(async (user) => {
      if (!user) {
        request.log.warn({ correlationId }, 'ws: unauthorized upgrade')
        ws.close(1008, 'unauthorized')
        return
      }
      authed = user
      const wasOnline = hasActiveSocket(user.id)
      const lastSeenIso = await touchLastSeen(user.id)
      const related = await getRelatedUserIds(user.id)
      registerUserSocket(user.id, ws, (uid) => {
        void (async () => {
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

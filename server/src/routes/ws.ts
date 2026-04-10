import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, messages } from '../db/schema.js'
import { getAuthUser, type AuthUser } from '../lib/auth-user.js'
import { sendPushToUser } from '../lib/push.js'
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
    }>(ticket)
    if (p.scope !== 'ws' || !p.sub || !p.username) return null
    return { id: p.sub, username: p.username }
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
        let json: unknown
        try {
          json = JSON.parse(bufferToString(raw))
        } catch {
          request.log.warn({ correlationId }, 'ws: invalid json frame')
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

          const [row] = await db
            .insert(messages)
            .values({
              chatId: p.chat_id,
              senderId: user.id,
              replyToId: p.reply_to_id ?? null,
              content: p.content ?? null,
              iv: p.iv ?? null,
              mediaPath: p.media_path ?? null,
              mediaType: p.media_type ?? null,
              mediaIv: p.media_iv ?? null,
            })
            .returning({
              id: messages.id,
              chatId: messages.chatId,
              senderId: messages.senderId,
              replyToId: messages.replyToId,
              content: messages.content,
              iv: messages.iv,
              mediaPath: messages.mediaPath,
              mediaType: messages.mediaType,
              mediaIv: messages.mediaIv,
              createdAt: messages.createdAt,
            })

          if (!row) {
            request.log.error(
              { correlationId, chatId: p.chat_id, userId: user.id },
              'ws: insert failed for chat_message'
            )
            ws.send(JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }))
            return
          }

          const ids = await getChatMemberIds(p.chat_id)
          const createdAt =
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : String(row.createdAt)

          broadcastToUsers(ids, {
            type: 'chat_message',
            message: {
              id: row.id,
              chat_id: row.chatId,
              sender_id: row.senderId,
              reply_to_id: row.replyToId,
              content: row.content,
              iv: row.iv,
              media_path: row.mediaPath,
              media_type: row.mediaType,
              media_iv: row.mediaIv,
              created_at: createdAt,
            },
          })

          for (const memberId of new Set(ids)) {
            if (memberId === user.id) continue
            if (!hasActiveSocket(memberId)) {
              void sendPushToUser(memberId, {
                title: 'Новое сообщение',
                body: 'Вам пришло зашифрованное сообщение',
                url: `/?chat=${p.chat_id}`,
                icon: '/wolf-logo.png',
              })
            }
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
          const otherIds = (await getChatMemberIds(chat_id)).filter(
            (id) => id !== user.id
          )
          broadcastToUsers(otherIds, {
            type: 'message_read',
            chat_id,
            message_id,
            reader_id: user.id,
          })
          return
        }

        ws.send(JSON.stringify({ type: 'error', error: 'UNKNOWN_MESSAGE_TYPE' }))
      })()
    }

    ws.on('message', (raw) => {
      if (!authed) {
        pending.push(raw)
        return
      }
      handleMessage(raw, authed)
    })

    void resolveWsUser(request).then((user) => {
      if (!user) {
        request.log.warn({ correlationId }, 'ws: unauthorized upgrade')
        ws.close(1008, 'unauthorized')
        return
      }
      authed = user
      registerUserSocket(user.id, ws)
      request.log.info({ correlationId, userId: user.id }, 'ws: connected')
      for (const raw of pending) {
        handleMessage(raw, user)
      }
      pending.length = 0
    })
  })
}

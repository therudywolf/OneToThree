import { and, eq } from 'drizzle-orm'
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

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (ws: WebSocket, request) => {
    const pending: unknown[] = []
    let authed: AuthUser | null = null

    const handleMessage = (raw: unknown, user: AuthUser) => {
      void (async () => {
        let json: unknown
        try {
          json = JSON.parse(bufferToString(raw))
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'INVALID_JSON' }))
          return
        }

        const chatParsed = chatMessageInSchema.safeParse(json)
        if (chatParsed.success) {
          const p = chatParsed.data
          const member = await db
            .select({ one: chatMembers.userId })
            .from(chatMembers)
            .where(
              and(
                eq(chatMembers.chatId, p.chat_id),
                eq(chatMembers.userId, user.id)
              )
            )
            .limit(1)
          if (!member.length) {
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
            ws.send(JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }))
            return
          }

          const memberRows = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(eq(chatMembers.chatId, p.chat_id))

          const ids = memberRows.map((m) => m.userId)
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
          sendToUser(targetUserId, {
            type: 'webrtc_signal',
            fromUserId: user.id,
            signalData,
          })
          return
        }

        const inviteParsed = callInviteSchema.safeParse(json)
        if (inviteParsed.success) {
          const { chat_id, is_video } = inviteParsed.data
          const memberOk = await db
            .select({ one: chatMembers.userId })
            .from(chatMembers)
            .where(
              and(
                eq(chatMembers.chatId, chat_id),
                eq(chatMembers.userId, user.id)
              )
            )
            .limit(1)
          if (!memberOk.length) {
            ws.send(JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }))
            return
          }
          const allMembers = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(eq(chatMembers.chatId, chat_id))
          const otherIds = allMembers
            .map((m) => m.userId)
            .filter((id) => id !== user.id)
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
          const allMembers = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(eq(chatMembers.chatId, chat_id))
          const otherIds = allMembers
            .map((m) => m.userId)
            .filter((id) => id !== user.id)
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
          const memberOk = await db
            .select({ one: chatMembers.userId })
            .from(chatMembers)
            .where(
              and(
                eq(chatMembers.chatId, chat_id),
                eq(chatMembers.userId, user.id)
              )
            )
            .limit(1)
          if (!memberOk.length) return
          const allMembers = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(eq(chatMembers.chatId, chat_id))
          const otherIds = allMembers
            .map((m) => m.userId)
            .filter((id) => id !== user.id)
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
        ws.close(1008, 'unauthorized')
        return
      }
      authed = user
      registerUserSocket(user.id, ws)
      for (const raw of pending) {
        handleMessage(raw, user)
      }
      pending.length = 0
    })
  })
}

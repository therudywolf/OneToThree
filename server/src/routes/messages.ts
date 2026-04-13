import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, messageDeliveries, messages } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  persistChatMessageAndFanOut,
  persistedRowToClientJson,
} from '../lib/chat-message-persist.js'
import { parseOptionalBurnAt } from '../lib/burn-at.js'
import { resolveMediaOriginalBytes } from '../lib/message-send-helpers.js'
import { isBlocked } from '../lib/block-check.js'
import { markMessageReadByReader, markMessagesReadByReader } from '../lib/mark-message-read.js'
import { broadcastToUsers } from '../ws/registry.js'

const deleteMessageSchema = z.object({
  for_everyone: z.boolean().default(false),
})

const sendMessageBodySchema = z.object({
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

const deliveredAckSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(200),
})

const batchReadSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(200),
})

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  /** Encrypted store-and-forward when WebSocket is unavailable (same payload as WS `chat_message`). */
  app.post('/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = sendMessageBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const p = parsed.data
    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, p.chat_id), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    // In direct chats, enforce block check against the other member
    const allMembers = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, p.chat_id))
    if (allMembers.length === 2) {
      const peerId = allMembers.find((m) => m.userId !== user.id)?.userId
      if (peerId && await isBlocked(user.id, peerId)) {
        return reply.status(403).send({ error: 'BLOCKED' })
      }
    }

    const burn = parseOptionalBurnAt(p.burn_at ?? null)
    if (!burn.ok) {
      return reply.status(400).send({ error: burn.error })
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
      return reply.status(500).send({ error: 'INSERT_FAILED' })
    }
    return reply.send({ message: persistedRowToClientJson(persisted.row) })
  })

  /** Pending ciphertext rows for this user (not yet acknowledged after delivery sync). */
  app.get('/sync/pending', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const q = request.query as { chat_id?: string }
    const chatId = q.chat_id?.trim()
    if (chatId && !z.string().uuid().safeParse(chatId).success) {
      return reply.status(400).send({ error: 'INVALID_CHAT_ID' })
    }

    const memberFilter = chatId
      ? and(
          eq(messageDeliveries.userId, user.id),
          isNull(messageDeliveries.deliveredAt),
          eq(messages.chatId, chatId)
        )
      : and(
          eq(messageDeliveries.userId, user.id),
          isNull(messageDeliveries.deliveredAt)
        )

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        replyToId: messages.replyToId,
        content: messages.content,
        iv: messages.iv,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        burnAt: messages.burnAt,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(
        messageDeliveries,
        eq(messages.id, messageDeliveries.messageId)
      )
      .innerJoin(
        chatMembers,
        and(
          eq(chatMembers.chatId, messages.chatId),
          eq(chatMembers.userId, user.id)
        )
      )
      .where(memberFilter)
      .orderBy(asc(messages.createdAt))
      .limit(200)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        reply_to_id: m.replyToId,
        content: m.content,
        iv: m.iv,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        read_at:
          m.readAt == null
            ? null
            : m.readAt instanceof Date
              ? m.readAt.toISOString()
              : String(m.readAt),
        burn_at:
          m.burnAt == null
            ? null
            : m.burnAt instanceof Date
              ? m.burnAt.toISOString()
              : String(m.burnAt),
        created_at:
          m.createdAt instanceof Date
            ? m.createdAt.toISOString()
            : String(m.createdAt),
      })),
    })
  })

  app.post('/delivered', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = deliveredAckSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const ids = parsed.data.message_ids
    await db
      .update(messageDeliveries)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(messageDeliveries.userId, user.id),
          inArray(messageDeliveries.messageId, ids)
        )
      )
    return reply.send({ ok: true })
  })

  /** Mark a direct message as read (REST; mirrors WebSocket `message_read`). */
  app.post('/read/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { messageId } = request.params as { messageId: string }
    const result = await markMessageReadByReader(user.id, messageId)
    if (!result.ok) {
      const status: Record<string, number> = {
        MESSAGE_NOT_FOUND: 404,
        NOT_A_MEMBER: 403,
        READ_RECEIPTS_DIRECT_ONLY: 400,
        CANNOT_READ_OWN_MESSAGE: 400,
        NOT_READABLE: 400,
        CHAT_MISMATCH: 400,
      }
      return reply
        .status(status[result.error] ?? 400)
        .send({ error: result.error })
    }
    return reply.send({ ok: true, read_at: result.read_at })
  })

  /** Batch mark multiple messages as read (optimize scrolling through many messages). */
  app.post('/batch-read', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = batchReadSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const messageIds = parsed.data.message_ids
    const results = await markMessagesReadByReader(user.id, messageIds)
    const successful = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    return reply.send({
      ok: true,
      marked_count: successful.length,
      failed_count: failed.length,
      results: results,
    })
  })

  /** Voice/audio/video index for media archive (newest first). */
  app.get('/:chatId/media', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

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

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          isNotNull(messages.mediaPath),
          or(
            eq(messages.mediaType, 'audio'),
            eq(messages.mediaType, 'video')
          )
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(300)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        created_at:
          m.createdAt instanceof Date
            ? m.createdAt.toISOString()
            : String(m.createdAt),
      })),
    })
  })

  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { chatId } = request.params as { chatId: string }

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

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        replyToId: messages.replyToId,
        content: messages.content,
        iv: messages.iv,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        burnAt: messages.burnAt,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt))
      .limit(500)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        reply_to_id: m.replyToId,
        content: m.content,
        iv: m.iv,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        read_at:
          m.readAt == null
            ? null
            : m.readAt instanceof Date
              ? m.readAt.toISOString()
              : String(m.readAt),
        burn_at:
          m.burnAt == null
            ? null
            : m.burnAt instanceof Date
              ? m.burnAt.toISOString()
              : String(m.burnAt),
        created_at:
          m.createdAt instanceof Date
            ? m.createdAt.toISOString()
            : String(m.createdAt),
      })),
    })
  })

  app.delete('/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { messageId } = request.params as { messageId: string }

    const parsed = deleteMessageSchema.safeParse(request.body ?? {})
    const forEveryone = parsed.success ? parsed.data.for_everyone : false

    const [msg] = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!msg) return reply.status(404).send({ error: 'MESSAGE_NOT_FOUND' })

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(
          eq(chatMembers.chatId, msg.chatId),
          eq(chatMembers.userId, user.id)
        )
      )
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    if (forEveryone) {
      if (msg.senderId !== user.id) {
        return reply.status(403).send({ error: 'NOT_SENDER' })
      }
      await db.delete(messages).where(eq(messages.id, messageId))

      const members = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, msg.chatId))
      broadcastToUsers(
        members.map((m) => m.userId),
        {
          type: 'message_deleted',
          message_id: messageId,
          chat_id: msg.chatId,
        }
      )
    } else {
      await db.delete(messages).where(
        and(eq(messages.id, messageId), eq(messages.senderId, user.id))
      )
    }

    return reply.send({ ok: true })
  })
}

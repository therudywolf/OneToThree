import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, chats, messageDeliveries, messages } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'
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

  /** Server-side message search within a chat (ILIKE on plaintext content). */
  app.get('/search', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const q = request.query as { chatId?: string; q?: string; limit?: string }
    const chatId = q.chatId?.trim()
    const query = q.q?.trim()
    const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), 50)

    if (!chatId || !z.string().uuid().safeParse(chatId).success) {
      return reply.status(400).send({ error: 'INVALID_CHAT_ID' })
    }
    if (!query || query.length < 2) {
      return reply.status(400).send({ error: 'QUERY_TOO_SHORT' })
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

    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const pattern = `%${escaped}%`

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        content: messages.content,
        iv: messages.iv,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          isNotNull(messages.content),
          ilike(messages.content, pattern)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        content: m.content,
        iv: m.iv,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        created_at:
          m.createdAt instanceof Date
            ? m.createdAt.toISOString()
            : String(m.createdAt),
      })),
    })
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
    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data
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
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

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

  /** Shared media between two users across their direct chats. */
  app.get('/shared-media/:userId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { userId: targetUserId } = params.data
    const q = request.query as { type?: string }
    const filterType = q.type === 'files' ? 'files' : 'media'

    // Find all direct_e2e chats where both users are members
    const myDirectChats = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .innerJoin(chats, eq(chats.id, chatMembers.chatId))
      .where(and(eq(chatMembers.userId, user.id), eq(chats.type, 'direct_e2e')))

    const sharedChatIds: string[] = []
    for (const { chatId } of myDirectChats) {
      const peer = await db
        .select({ one: chatMembers.userId })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, targetUserId)))
        .limit(1)
      if (peer.length) sharedChatIds.push(chatId)
    }

    if (!sharedChatIds.length) {
      return reply.send({ messages: [] })
    }

    const mediaTypeFilter =
      filterType === 'media'
        ? or(
            eq(messages.mediaType, 'image'),
            eq(messages.mediaType, 'video')
          )
        : and(
            isNotNull(messages.mediaType),
            sql`${messages.mediaType} NOT IN ('image', 'video', 'audio')`
          )

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        content: messages.content,
        iv: messages.iv,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.chatId, sharedChatIds),
          isNotNull(messages.mediaPath),
          mediaTypeFilter
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(100)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        content: m.content,
        iv: m.iv,
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
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

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
    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data

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

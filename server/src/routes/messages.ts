import { and, asc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, messages } from '../db/schema.js'
import { getAuthUser } from '../lib/auth-user.js'
import { broadcastToUsers } from '../ws/registry.js'

const deleteMessageSchema = z.object({
  for_everyone: z.boolean().default(false),
})

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
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
        created_at:
          m.createdAt instanceof Date
            ? m.createdAt.toISOString()
            : String(m.createdAt),
      })),
    })
  })

  app.delete('/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!user) return reply.status(401).send({ error: 'UNAUTHORIZED' })
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

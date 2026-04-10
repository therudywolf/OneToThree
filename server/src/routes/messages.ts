import { and, asc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db/index.js'
import { chatMembers, messages } from '../db/schema.js'
import { getAuthUser } from '../lib/auth-user.js'

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request)
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
}

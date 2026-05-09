import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { attachments, chatMembers, chats, messages, users } from '../db/schema.js'
import { persistChatMessageAndFanOut } from './chat-message-persist.js'

describe('chat-message-persist', () => {
  it('links an attachment lifecycle row when media message is persisted', async () => {
    const username = `persist-${Date.now().toString(36)}`
    const [user] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id })
    const [chat] = await db
      .insert(chats)
      .values({ type: 'group_e2e', name: 'persist media' })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values({
      chatId: chat.id,
      userId: user.id,
      encryptedGroupKey: 'key',
      role: 'owner',
    })
    const objectKey = `chats/${chat.id}/${user.id}/${randomUUID()}.jpg`
    const [attachment] = await db
      .insert(attachments)
      .values({
        chatId: chat.id,
        uploaderId: user.id,
        bucket: 'media',
        objectKey,
        contentType: 'image/jpeg',
        sizeBytes: 123,
      })
      .returning({ id: attachments.id })

    try {
      const result = await persistChatMessageAndFanOut({
        chatId: chat.id,
        senderId: user.id,
        content: 'cipher',
        iv: 'iv',
        mediaPath: objectKey,
        mediaType: 'image',
        mediaIv: 'media-iv',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const [row] = await db
        .select({ messageId: attachments.messageId })
        .from(attachments)
        .where(eq(attachments.id, attachment.id))
        .limit(1)
      expect(row?.messageId).toBe(result.row.id)

      await db.delete(messages).where(eq(messages.id, result.row.id))
    } finally {
      await db.delete(attachments).where(eq(attachments.id, attachment.id))
      await db.delete(chatMembers).where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, user.id)))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})

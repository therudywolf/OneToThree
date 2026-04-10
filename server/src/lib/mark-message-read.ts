import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, chats, messages } from '../db/schema.js'
import { sendToUser } from '../ws/registry.js'

export type MarkReadResult =
  | {
      ok: true
      chat_id: string
      message_id: string
      sender_id: string
      reader_id: string
      read_at: string
    }
  | { ok: false; error: string }

function ts(v: Date | string | null): string {
  if (!v) return ''
  return v instanceof Date ? v.toISOString() : String(v)
}

/**
 * Marks a direct E2E message as read by `readerId`. Idempotent if already read.
 * Broadcasts `message_read_update` to the sender (all their sockets).
 * @param assertChatId — When set (e.g. WS frame), must match the message's chat.
 */
export async function markMessageReadByReader(
  readerId: string,
  messageId: string,
  assertChatId?: string
): Promise<MarkReadResult> {
  const [msg] = await db
    .select({
      id: messages.id,
      chatId: messages.chatId,
      senderId: messages.senderId,
      readAt: messages.readAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)

  if (!msg) return { ok: false, error: 'MESSAGE_NOT_FOUND' }

  if (assertChatId !== undefined && assertChatId !== msg.chatId) {
    return { ok: false, error: 'CHAT_MISMATCH' }
  }

  const [member] = await db
    .select({ one: chatMembers.userId })
    .from(chatMembers)
    .where(
      and(eq(chatMembers.chatId, msg.chatId), eq(chatMembers.userId, readerId))
    )
    .limit(1)
  if (!member) return { ok: false, error: 'NOT_A_MEMBER' }

  const [chat] = await db
    .select({ type: chats.type })
    .from(chats)
    .where(eq(chats.id, msg.chatId))
    .limit(1)
  if (chat?.type !== 'direct_e2e') {
    return { ok: false, error: 'READ_RECEIPTS_DIRECT_ONLY' }
  }

  if (msg.senderId === readerId) {
    return { ok: false, error: 'CANNOT_READ_OWN_MESSAGE' }
  }

  const [updated] = await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messages.id, messageId),
        isNull(messages.readAt),
        ne(messages.senderId, readerId)
      )
    )
    .returning({ readAt: messages.readAt })

  let readAtIso: string
  if (updated?.readAt) {
    readAtIso = ts(updated.readAt)
  } else {
    const [row] = await db
      .select({ readAt: messages.readAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (!row?.readAt) return { ok: false, error: 'NOT_READABLE' }
    readAtIso = ts(row.readAt)
  }

  sendToUser(msg.senderId, {
    type: 'message_read_update',
    chat_id: msg.chatId,
    message_id: msg.id,
    reader_id: readerId,
    read_at: readAtIso,
  })

  return {
    ok: true,
    chat_id: msg.chatId,
    message_id: msg.id,
    sender_id: msg.senderId,
    reader_id: readerId,
    read_at: readAtIso,
  }
}

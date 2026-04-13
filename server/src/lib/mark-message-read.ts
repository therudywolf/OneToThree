import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'
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
  // Check if the reader has disabled read receipts
  const [readerRow] = await db
    .select({ disableReadReceipts: users.disableReadReceipts })
    .from(users)
    .where(eq(users.id, readerId))
    .limit(1)
  if (readerRow?.disableReadReceipts) {
    // Silently succeed — don't record read or notify sender
    return { ok: false, error: 'READ_RECEIPTS_DISABLED' }
  }

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

/**
 * Batch mark multiple messages as read. Idempotent.
 * Uses a single UPDATE query instead of N individual queries.
 */
export async function markMessagesReadByReader(
  readerId: string,
  messageIds: string[]
): Promise<MarkReadResult[]> {
  if (!messageIds.length) return []

  // Check if the reader has disabled read receipts
  const [readerRow] = await db
    .select({ disableReadReceipts: users.disableReadReceipts })
    .from(users)
    .where(eq(users.id, readerId))
    .limit(1)
  if (readerRow?.disableReadReceipts) {
    return messageIds.map((id) => ({ ok: false as const, error: 'READ_RECEIPTS_DISABLED' }))
  }

  const now = new Date()

  // Batch update: mark all eligible messages as read in one query
  const updated = await db
    .update(messages)
    .set({ readAt: now })
    .where(
      and(
        inArray(messages.id, messageIds),
        isNull(messages.readAt),
        ne(messages.senderId, readerId)
      )
    )
    .returning({
      id: messages.id,
      chatId: messages.chatId,
      senderId: messages.senderId,
      readAt: messages.readAt,
    })

  const updatedMap = new Map(updated.map((r) => [r.id, r]))

  const results: MarkReadResult[] = []
  for (const msgId of messageIds) {
    const row = updatedMap.get(msgId)
    if (row) {
      const readAtIso = ts(row.readAt)
      // Notify sender
      sendToUser(row.senderId, {
        type: 'message_read_update',
        chat_id: row.chatId,
        message_id: row.id,
        reader_id: readerId,
        read_at: readAtIso,
      })
      results.push({
        ok: true,
        chat_id: row.chatId,
        message_id: row.id,
        sender_id: row.senderId,
        reader_id: readerId,
        read_at: readAtIso,
      })
    } else {
      results.push({ ok: false, error: 'NOT_UPDATED' })
    }
  }
  return results
}

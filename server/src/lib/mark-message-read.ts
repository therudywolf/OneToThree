import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'
import { sendToUser } from '../ws/registry.js'

/**
 * Burn-after-read with a DURATION stores burn_duration_secs at send and leaves
 * burn_at NULL ("started at read time"). Compute the absolute burn_at here, in
 * the same UPDATE that sets read_at, so the countdown actually begins. Duration
 * takes precedence; a legacy absolute burn_at (no duration) is preserved.
 */
const burnAtOnReadSql = sql`CASE WHEN ${messages.burnDurationSecs} IS NOT NULL THEN now() + (${messages.burnDurationSecs} * interval '1 second') ELSE ${messages.burnAt} END`

export type MarkReadResult =
  | {
      ok: true
      chat_id: string
      message_id: string
      sender_id: string
      reader_id: string
      read_at: string
      burn_at?: string | null
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
  // "Disable read receipts" is a PRIVACY toggle about telling the SENDER —
  // it must not stop us recording the read STATE. Bailing out here left
  // read_at NULL forever, so the reader's own unread badge (derived from
  // read_at in GET /chats) could never reach 0 and burn_at was never armed,
  // which kept burn-after-read messages alive for the 30-day never-read
  // fallback. Record the read below; only the sender-facing receipt is
  // suppressed (here and in GET /messages/:chatId).
  const [readerRow] = await db
    .select({ disableReadReceipts: users.disableReadReceipts })
    .from(users)
    .where(eq(users.id, readerId))
    .limit(1)
  const suppressReceipt = readerRow?.disableReadReceipts === true

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
    .set({ readAt: new Date(), burnAt: burnAtOnReadSql })
    .where(
      and(
        eq(messages.id, messageId),
        isNull(messages.readAt),
        ne(messages.senderId, readerId)
      )
    )
    .returning({ readAt: messages.readAt, burnAt: messages.burnAt })

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
    // Idempotent retry: already marked read — do not notify sender again (avoids duplicate receipts).
    return {
      ok: true,
      chat_id: msg.chatId,
      message_id: msg.id,
      sender_id: msg.senderId,
      reader_id: readerId,
      read_at: ts(row.readAt),
      burn_at: row.readAt ? null : null,
    }
  }

  const burnAtIso = updated?.burnAt instanceof Date
    ? updated.burnAt.toISOString()
    : updated?.burnAt != null
    ? String(updated.burnAt)
    : null

  if (!suppressReceipt) {
    sendToUser(msg.senderId, {
      type: 'message_read_update',
      chat_id: msg.chatId,
      message_id: msg.id,
      reader_id: readerId,
      read_at: readAtIso,
      ...(burnAtIso ? { burn_at: burnAtIso } : {}),
    })
  }

  // Notify reader's own sockets so their UI starts the burn countdown
  sendToUser(readerId, {
    type: 'message_read_update',
    chat_id: msg.chatId,
    message_id: msg.id,
    reader_id: readerId,
    read_at: readAtIso,
    ...(burnAtIso ? { burn_at: burnAtIso } : {}),
  })

  return {
    ok: true,
    chat_id: msg.chatId,
    message_id: msg.id,
    sender_id: msg.senderId,
    reader_id: readerId,
    read_at: readAtIso,
    burn_at: burnAtIso,
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

  // See markMessageReadByReader: the toggle suppresses the sender-facing
  // receipt, not the read state itself.
  const [readerRow] = await db
    .select({ disableReadReceipts: users.disableReadReceipts })
    .from(users)
    .where(eq(users.id, readerId))
    .limit(1)
  const suppressReceipt = readerRow?.disableReadReceipts === true

  const targetIds = Array.from(new Set(messageIds))

  // Build eligible set first (reader must be member and chat must support read receipts).
  const eligible = await db
    .select({
      id: messages.id,
      chatId: messages.chatId,
      senderId: messages.senderId,
      readAt: messages.readAt,
      chatType: chats.type,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .innerJoin(
      chatMembers,
      and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, readerId))
    )
    .where(inArray(messages.id, targetIds))

  const eligibleMap = new Map(eligible.map((r) => [r.id, r]))
  const updatableIds = eligible
    .filter((r) => r.chatType === 'direct_e2e' && r.senderId !== readerId && r.readAt == null)
    .map((r) => r.id)

  let updatedMap = new Map<string, { id: string; chatId: string; senderId: string; readAt: Date | string | null; burnAt: Date | string | null }>()
  if (updatableIds.length > 0) {
    const updated = await db
      .update(messages)
      .set({ readAt: new Date(), burnAt: burnAtOnReadSql })
      .where(
        and(
          inArray(messages.id, updatableIds),
          isNull(messages.readAt),
          ne(messages.senderId, readerId)
        )
      )
      .returning({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        readAt: messages.readAt,
        burnAt: messages.burnAt,
      })
    updatedMap = new Map(updated.map((r) => [r.id, r]))
  }

  // Hydrate idempotent results for rows that were already marked read.
  const resolvedReadAtRows = await db
    .select({
      id: messages.id,
      chatId: messages.chatId,
      senderId: messages.senderId,
      readAt: messages.readAt,
    })
    .from(messages)
    .where(inArray(messages.id, eligible.map((r) => r.id)))

  const finalReadAtMap = new Map(resolvedReadAtRows.map((r) => [r.id, r]))

  const results: MarkReadResult[] = []
  for (const msgId of targetIds) {
    const base = eligibleMap.get(msgId)
    if (!base) {
      results.push({ ok: false, error: 'MESSAGE_NOT_FOUND_OR_NOT_A_MEMBER' })
      continue
    }
    if (base.chatType !== 'direct_e2e') {
      results.push({ ok: false, error: 'READ_RECEIPTS_DIRECT_ONLY' })
      continue
    }
    if (base.senderId === readerId) {
      results.push({ ok: false, error: 'CANNOT_READ_OWN_MESSAGE' })
      continue
    }
    const finalRow = finalReadAtMap.get(msgId)
    if (!finalRow?.readAt) {
      results.push({ ok: false, error: 'NOT_READABLE' })
      continue
    }
    const readAtIso = ts(finalRow.readAt)
    const updatedRow = updatedMap.get(msgId)
    const burnAtIso = updatedRow?.burnAt ? ts(updatedRow.burnAt) : null
    if (updatedRow) {
      // Notify the sender AND the reader's own sockets so the burn countdown
      // starts on every device of the conversation.
      const event = {
        type: 'message_read_update' as const,
        chat_id: finalRow.chatId,
        message_id: finalRow.id,
        reader_id: readerId,
        read_at: readAtIso,
        ...(burnAtIso ? { burn_at: burnAtIso } : {}),
      }
      if (!suppressReceipt) sendToUser(finalRow.senderId, event)
      sendToUser(readerId, event)
    }
    results.push({
      ok: true,
      chat_id: finalRow.chatId,
      message_id: finalRow.id,
      sender_id: finalRow.senderId,
      reader_id: readerId,
      read_at: readAtIso,
      burn_at: burnAtIso,
    })
  }
  return results
}

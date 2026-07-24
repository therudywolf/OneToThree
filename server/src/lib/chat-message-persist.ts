import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { attachments, chatMembers, messageDeliveries, messages } from '../db/schema.js'
import { sendNativePushToUser, sendPushToUser } from './push.js'
import {
  areOnline,
  broadcastToUsers,
} from '../ws/registry.js'

export type PersistedMessageRow = {
  id: string
  chatId: string
  senderId: string
  replyToId: string | null
  /** Sender of the message this one REPLIES to (#5). Resolved and authorized by
   *  the caller (the parent must live in the same chat), never inferred here —
   *  the insert's RETURNING cannot see the parent row. */
  replyToSenderId: string | null
  content: string | null
  iv: string | null
  mediaPath: string | null
  mediaType: string | null
  mediaIv: string | null
  mediaOriginalBytes: number | null
  burnAt: Date | null
  burnDurationSecs: number | null
  readAt: Date | null
  createdAt: Date
  protocolVersion: number
  drHeader: string | null
  drInit: string | null
  senderEcdhPublicKeyJwk: string | null
}

export type PersistChatMessageInput = {
  chatId: string
  senderId: string
  replyToId?: string | null
  /** Sender of the replied-to message (#5). The caller MUST have verified the
   *  parent belongs to `chatId` before passing it — echoing an unvalidated
   *  parent's sender would turn the send endpoint into a cross-chat
   *  "who wrote message <uuid>" oracle. */
  replyToSenderId?: string | null
  content: string | null
  iv: string | null
  mediaPath?: string | null
  mediaType?: string | null
  mediaIv?: string | null
  mediaOriginalBytes?: number | null
  burnAt?: Date | null
  /** Duration in seconds for burn-after-read. When set, burn_at is computed at read time. */
  burnDurationSecs?: number | null
  /** Protocol version (1 = legacy static ECDH, 2 = Double Ratchet). */
  protocolVersion?: number
  /** Base64url header for v2; ignored for v1. */
  drHeader?: string | null
  /** JSON X3DH init payload for v2 first message; ignored for v1. */
  drInit?: string | null
  /** Sender's ECDH public key JWK at send time — persisted so decryption survives multi-device key rotation. */
  senderEcdhPublicKeyJwk?: string | null
  /**
   * Extra attachment object keys belonging to this message (album items 2..N).
   * mediaPath is item 1; these are the rest. All are linked to the message so
   * the orphan-cleanup sweep doesn't hard-delete album items after 24h. The
   * caller MUST have validated each key the same way as mediaPath.
   */
  attachmentKeys?: string[]
  /**
   * Per-device E2EE ciphertext slots. When supplied they are inserted in the
   * SAME transaction as the message row, so the message and its slots commit
   * (or roll back) atomically.
   */
  deliverySlots?: Array<{
    deviceId: string
    userId: string
    ciphertext: string
    iv: string
    deliveredAt: Date | null
  }>
}

/**
 * True iff `key` is a well-formed media object key owned by (chatId, uploaderId).
 * Object keys are `chats/{chatId}/{uploaderId}/{uuid}{ext}`; /storage/download-url
 * authorizes on "some message in a chat I belong to references this key", so a
 * member must not be able to attach another chat's key. Shared by the REST and
 * WS send paths so album items 2..N are validated identically to media_path.
 */
export function isOwnedMediaKey(key: string, chatId: string, uploaderId: string): boolean {
  if (typeof key !== 'string' || key.trim() === '') return false
  if (key.includes('..') || key.includes('\\')) return false
  return key.startsWith(`chats/${chatId}/${uploaderId}/`)
}

function rowToWireMessage(row: PersistedMessageRow) {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt)
  const readAt =
    row.readAt == null
      ? null
      : row.readAt instanceof Date
        ? row.readAt.toISOString()
        : String(row.readAt)
  const burnAt =
    row.burnAt == null
      ? null
      : row.burnAt instanceof Date
        ? row.burnAt.toISOString()
        : String(row.burnAt)
  return {
    id: row.id,
    chat_id: row.chatId,
    sender_id: row.senderId,
    reply_to_id: row.replyToId,
    reply_to_sender_id: row.replyToSenderId ?? null,
    content: row.content,
    iv: row.iv,
    media_path: row.mediaPath,
    media_type: row.mediaType,
    media_iv: row.mediaIv,
    burn_at: burnAt,
    read_at: readAt,
    created_at: createdAt,
    protocol_version: row.protocolVersion,
    dr_header: row.drHeader,
    dr_init: row.drInit,
    sender_ecdh_public_key_jwk: row.senderEcdhPublicKeyJwk,
  }
}

async function getChatMemberIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
  return rows.map((m) => m.userId)
}

/**
 * Inserts ciphertext into `messages`, fan-outs over WebSocket, and notifies
 * offline members via Web Push.
 *
 * Per-device `message_deliveries` slots, when passed via `deliverySlots`, are
 * inserted INSIDE the message transaction: the message row and its ciphertext
 * slots commit together, so a recipient is never notified (WS + push) about a
 * message that has no slot it can decrypt. Legacy/group_e2e shared-key chats
 * pass no slots and are unaffected.
 */
export async function persistChatMessageAndFanOut(
  input: PersistChatMessageInput
): Promise<
  | { ok: true; row: PersistedMessageRow }
  | { ok: false; error: 'INSERT_FAILED' }
> {
  const row = await db.transaction(async (tx) => {
    const protocolVersion = input.protocolVersion ?? 1
    const [inserted] = await tx
      .insert(messages)
      .values({
        chatId: input.chatId,
        senderId: input.senderId,
        replyToId: input.replyToId ?? null,
        content: input.content,
        iv: input.iv,
        mediaPath: input.mediaPath ?? null,
        mediaType: input.mediaType ?? null,
        mediaIv: input.mediaIv ?? null,
        mediaOriginalBytes: input.mediaOriginalBytes ?? null,
        burnAt: input.burnAt ?? null,
        burnDurationSecs: input.burnDurationSecs ?? null,
        protocolVersion,
        drHeader: protocolVersion === 2 ? input.drHeader ?? null : null,
        drInit: protocolVersion === 2 ? input.drInit ?? null : null,
        senderEcdhPublicKeyJwk: input.senderEcdhPublicKeyJwk ?? null,
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
        mediaOriginalBytes: messages.mediaOriginalBytes,
        burnAt: messages.burnAt,
        burnDurationSecs: messages.burnDurationSecs,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
        protocolVersion: messages.protocolVersion,
        drHeader: messages.drHeader,
        drInit: messages.drInit,
        senderEcdhPublicKeyJwk: messages.senderEcdhPublicKeyJwk,
      })

    if (!inserted) return null

    // Link the lifecycle rows to this message so eviction/orphan-cleanup can
    // distinguish referenced media from orphan uploads. For albums, link ALL
    // items (mediaPath is item 1; attachmentKeys are 2..N) — otherwise items
    // 2..N keep message_id=NULL and get hard-deleted after 24h (data loss).
    const linkKeys = inserted.mediaPath
      ? Array.from(new Set([inserted.mediaPath, ...(input.attachmentKeys ?? [])]))
      : input.attachmentKeys && input.attachmentKeys.length > 0
        ? Array.from(new Set(input.attachmentKeys))
        : []
    if (linkKeys.length > 0) {
      await tx
        .update(attachments)
        .set({ messageId: inserted.id })
        .where(inArray(attachments.objectKey, linkKeys))
    }

    // Per-device E2EE ciphertext slots — committed atomically with the
    // message row so the message can never be visible without them.
    if (input.deliverySlots && input.deliverySlots.length > 0) {
      await tx
        .insert(messageDeliveries)
        .values(
          input.deliverySlots.map((s) => ({
            messageId: inserted.id,
            deviceId: s.deviceId,
            userId: s.userId,
            ciphertext: s.ciphertext,
            iv: s.iv,
            deliveredAt: s.deliveredAt,
          }))
        )
        .onConflictDoNothing()
    }

    // The parent's sender cannot come from RETURNING (it is a different row), so
    // it rides in on the already-authorized input (#5).
    return {
      ...inserted,
      replyToSenderId: input.replyToSenderId ?? null,
    } as PersistedMessageRow
  })

  if (!row) {
    return { ok: false, error: 'INSERT_FAILED' }
  }

  const ids = await getChatMemberIds(input.chatId)
  broadcastToUsers(ids, {
    type: 'chat_message',
    message: rowToWireMessage(row),
  })

  await notifyOfflineMembers(input.chatId, ids, input.senderId, row)

  return { ok: true, row }
}

/**
 * Push to every chat member who is not currently connected.
 *
 * Extracted from the send path so the presence lookup and the payload shape can
 * evolve independently.
 *
 * `reply_to_me` is computed PER RECIPIENT and is deliberately a BOOLEAN: the raw
 * `reply_to_sender_id` must never reach Web Push / FCM, which today see only a
 * chat_id — shipping it would hand a stable user uuid to Google/Apple/Mozilla
 * infrastructure. The boolean is all the service worker needs to distinguish a
 * reply-to-you from an ordinary message (#5).
 */
async function notifyOfflineMembers(
  chatId: string,
  memberIds: string[],
  senderId: string,
  row: PersistedMessageRow
): Promise<void> {
  const recipients = [...new Set(memberIds)].filter((id) => id !== senderId)
  if (recipients.length === 0) return
  // ONE batched presence read for the whole member list (#26). A per-member
  // lookup would add O(members) sequential Redis round trips to the awaited
  // send path — the exact regression a naive port of hasActiveSocket causes.
  const online = await areOnline(recipients)
  const offline = recipients.filter((id) => !online.get(id))
  if (offline.length === 0) return

  // Bounded fan-out. The old loop launched two detached DB-backed sends per
  // offline member simultaneously — 10k in-flight queries for a 5k-member group
  // against a pool of 20 — which is how a routine group send turned into a
  // connect_timeout storm in the first place. Run it detached from the caller
  // (nobody awaits a push) but internally serialized into small chunks so the
  // pool is never swamped.
  const PUSH_CHUNK = 10
  void (async () => {
    for (let i = 0; i < offline.length; i += PUSH_CHUNK) {
      const chunk = offline.slice(i, i + PUSH_CHUNK)
      await Promise.allSettled(chunk.flatMap((memberId) => sendBoth(memberId)))
    }
  })()

  function sendBoth(memberId: string): Array<Promise<void>> {
    const payload = {
      title: 'Новое сообщение',
      body: 'Вам пришло зашифрованное сообщение',
      url: `/?chat=${chatId}`,
      icon: '/wolf-logo.png',
      chat_id: chatId,
      type: 'message' as const,
      reply_to_me: row.replyToSenderId != null && row.replyToSenderId === memberId,
    }
    // Terminal handlers are mandatory here, not defensive style: index.ts
    // escalates ANY unhandledRejection to a full process shutdown, and both of
    // these open their own un-guarded `db.select()`. Previously the first push
    // query to exceed connect_timeout rejected with nothing to catch it, and
    // that single rejection killed the whole API — every other user's socket,
    // call and upload with it. The WS call-invite fan-out already gets this
    // right (routes/ws.ts wraps each push in .catch() + Promise.allSettled);
    // this path did not.
    return [
      sendPushToUser(memberId, payload).catch(() => { /* best-effort */ }),
      sendNativePushToUser(memberId, payload).catch(() => { /* best-effort */ }),
    ]
  }
}

export function persistedRowToClientJson(row: PersistedMessageRow) {
  return rowToWireMessage(row)
}

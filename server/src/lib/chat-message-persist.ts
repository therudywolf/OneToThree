import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, messages } from '../db/schema.js'
import { sendNativePushToUser, sendPushToUser } from './push.js'
import {
  broadcastToUsers,
  hasActiveSocket,
} from '../ws/registry.js'

export type PersistedMessageRow = {
  id: string
  chatId: string
  senderId: string
  replyToId: string | null
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
 * NOTE: `message_deliveries` rows (per-device E2EE slots) are NOT created here.
 * They are created by the dedicated E2EE fan-out route (POST /devices/:id/messages).
 * This keeps legacy/group_e2e shared-key chats working without a deviceId.
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

    return inserted as PersistedMessageRow
  })

  if (!row) {
    return { ok: false, error: 'INSERT_FAILED' }
  }

  const ids = await getChatMemberIds(input.chatId)
  broadcastToUsers(ids, {
    type: 'chat_message',
    message: rowToWireMessage(row),
  })

  for (const memberId of new Set(ids)) {
    if (memberId === input.senderId) continue
    if (!hasActiveSocket(memberId)) {
      const payload = {
        title: 'Новое сообщение',
        body: 'Вам пришло зашифрованное сообщение',
        url: `/?chat=${input.chatId}`,
        icon: '/wolf-logo.png',
        chat_id: input.chatId,
        type: 'message' as const,
      }
      void sendPushToUser(memberId, payload)
      void sendNativePushToUser(memberId, payload)
    }
  }

  return { ok: true, row }
}

export function persistedRowToClientJson(row: PersistedMessageRow) {
  return rowToWireMessage(row)
}

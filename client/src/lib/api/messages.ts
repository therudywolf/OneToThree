import { fetchWithTimeout } from '@/lib/api/fetch'
import type { ApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { API_URL } from './auth'

export type SendChatMessageBody = {
  chat_id: string
  content: string | null
  iv: string | null
  ciphertexts?: Array<{
    device_id: string
    ciphertext: string
    iv: string
  }>
  reply_to_id?: string | null
  media_path?: string | null
  media_type?: string | null
  media_iv?: string | null
  media_original_bytes?: number | null
  burn_at?: string | null
  /**
   * Phase 6 — Double Ratchet transport.
   * Omit or set to 1 for legacy static-ECDH; set to 2 for DR.
   */
  protocol_version?: 1 | 2
  /** Base64url `{ dhPub, prevN, n }`. Required when protocol_version=2. */
  dr_header?: string | null
  /** JSON X3DH handshake payload. Only on the first v2 message of a session. */
  dr_init?: string | null
}

/** REST store-and-forward when the WebSocket is not connected. */
export async function postSendChatMessage(
  body: SendChatMessageBody
): Promise<ApiMessageRow> {
  const res = await fetchWithTimeout(`${API_URL}/messages/send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    message?: ApiMessageRow
    error?: string
  }
  if (!res.ok || !data.message) {
    throw new Error(data.error ?? 'SEND_MESSAGE_FAILED')
  }
  return data.message
}

/** Pending rows for the current user (undelivered ciphertext) in a chat. */
export async function fetchPendingDeliveries(
  chatId: string
): Promise<ApiMessageRow[]> {
  const res = await fetchWithTimeout(
    `${API_URL}/messages/sync/pending?chat_id=${encodeURIComponent(chatId)}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as {
    messages?: ApiMessageRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'PENDING_SYNC_FAILED')
  }
  return data.messages ?? []
}

const DELIVERED_ACK_CHUNK = 200

/** Marks server-side delivery rows so `/sync/pending` does not replay messages. */
export async function acknowledgeMessagesDelivered(
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return
  for (let i = 0; i < messageIds.length; i += DELIVERED_ACK_CHUNK) {
    const chunk = messageIds.slice(i, i + DELIVERED_ACK_CHUNK)
    const res = await fetchWithTimeout(`${API_URL}/messages/delivered`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: chunk }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      throw new Error(data.error ?? 'DELIVERED_ACK_FAILED')
    }
  }
}

/** POST /api/messages/read/:messageId — idempotent mark read (direct E2E). */
export async function markMessageRead(messageId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/messages/read/${messageId}`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'MARK_READ_FAILED')
  }
}

/** POST /api/messages/batch-read — batch mark multiple messages as read (optimized for scrolling). */
export async function markMessagesReadBatch(messageIds: string[]): Promise<void> {
  if (!messageIds.length) return
  const res = await fetchWithTimeout(`${API_URL}/messages/batch-read`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_ids: messageIds }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'BATCH_READ_FAILED')
  }
}

/**
 * Server-side message search has been removed (see MIGRATION_NOTES v4).
 * Use `useLocalSearch` from `@/hooks/use-local-search` which searches
 * decrypted plaintext in memory (and `searchLocalMessages` in
 * `@/lib/message-cache` for the token-index fallback).
 */

export type SharedMediaRow = {
  id: string
  chat_id: string
  sender_id: string
  media_path: string | null
  media_type: string | null
  media_iv: string | null
  content: string | null
  iv: string | null
  created_at: string
}

/** GET /api/messages/shared-media/:userId — shared media between auth user and target. */
export async function fetchSharedMedia(
  userId: string,
  type: 'media' | 'files' = 'media'
): Promise<SharedMediaRow[]> {
  const res = await fetchWithTimeout(
    `${API_URL}/messages/shared-media/${userId}?type=${type}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as {
    messages?: SharedMediaRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'SHARED_MEDIA_FAILED')
  }
  return data.messages ?? []
}

export type MediaArchiveRow = {
  id: string
  chat_id: string
  sender_id: string
  media_path: string | null
  media_type: string | null
  media_iv: string | null
  created_at: string
}

/** GET /api/messages/:chatId/media — voice/video archive (newest first). */
export async function fetchChatMediaArchive(
  chatId: string
): Promise<MediaArchiveRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/messages/${chatId}/media`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    messages?: MediaArchiveRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'MEDIA_ARCHIVE_FAILED')
  }
  return data.messages ?? []
}

import type { ApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { API_URL } from './auth'

export type SendChatMessageBody = {
  chat_id: string
  content: string | null
  iv: string | null
  reply_to_id?: string | null
  media_path?: string | null
  media_type?: string | null
  media_iv?: string | null
}

/** REST store-and-forward when the WebSocket is not connected. */
export async function postSendChatMessage(
  body: SendChatMessageBody
): Promise<ApiMessageRow> {
  const res = await fetch(`${API_URL}/messages/send`, {
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
  const res = await fetch(
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
    const res = await fetch(`${API_URL}/messages/delivered`, {
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
  const res = await fetch(`${API_URL}/messages/read/${messageId}`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'MARK_READ_FAILED')
  }
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
  const res = await fetch(`${API_URL}/messages/${chatId}/media`, {
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

import { API_URL } from './auth'

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

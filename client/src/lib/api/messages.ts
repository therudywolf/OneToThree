import { API_URL } from './auth'

export type MediaArchiveRow = {
  id: string
  chat_id: string
  sender_id: string
  media_path: string | null
  media_type: string | null
  media_iv: string | null
  created_at: string
}

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

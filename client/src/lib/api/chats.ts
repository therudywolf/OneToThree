import { API_URL } from './auth'

export type ApiChatRow = {
  id: string
  name: string | null
  type: string
  is_group: boolean
  member_ids: string[]
  /** Present for group_e2e: wrapped group key for the current user. */
  encrypted_group_key?: string | null
}

export async function fetchChatsList(): Promise<ApiChatRow[]> {
  const res = await fetch(`${API_URL}/chats`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    chats?: ApiChatRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'CHATS_FETCH_FAILED')
  }
  return data.chats ?? []
}

export async function createDirectE2EChat(
  myUserId: string,
  peerUserId: string
): Promise<ApiChatRow> {
  const res = await fetch(`${API_URL}/chats`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'direct_e2e',
      member_ids: [myUserId, peerUserId],
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ApiChatRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'CHAT_CREATE_FAILED')
  }
  if (!data.chat?.id) {
    throw new Error('INVALID_CREATE_CHAT_RESPONSE')
  }
  return data.chat
}

export async function createGroupE2EChat(params: {
  name?: string | null
  members: Array<{ userId: string; encryptedGroupKey: string }>
}): Promise<ApiChatRow> {
  const res = await fetch(`${API_URL}/chats`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'group_e2e',
      name: params.name?.trim() || null,
      members: params.members,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ApiChatRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'GROUP_CREATE_FAILED')
  }
  if (!data.chat?.id) {
    throw new Error('INVALID_GROUP_CREATE_RESPONSE')
  }
  return data.chat
}

export async function fetchPeerIdsForChat(
  chatId: string,
  myUserId: string
): Promise<string[]> {
  const chats = await fetchChatsList()
  const c = chats.find((x) => x.id === chatId)
  if (!c) return []
  return c.member_ids.filter((id) => id !== myUserId)
}

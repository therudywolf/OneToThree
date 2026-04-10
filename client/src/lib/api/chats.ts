import { API_URL } from './auth'
import { canonicalUserId } from '@/lib/user-id'

export type ChatMemberRole = 'owner' | 'admin' | 'member'

export type ApiChatRow = {
  id: string
  name: string | null
  type: string
  is_group: boolean
  member_ids: string[]
  /** Present for group_e2e: wrapped group key for the current user. */
  encrypted_group_key?: string | null
  /** ISO timestamp of the newest message in this chat, if any. */
  last_message_at?: string | null
  /** Group / public: server-side pack role. */
  my_role?: ChatMemberRole
  /** Group: invite slug when you may manage links. */
  invite_code?: string | null
}

export type ChatDetailMember = {
  user_id: string
  username: string
  ecdh_public_key_jwk: string | null
  avatar_key?: string | null
  encrypted_group_key: string | null
  role: ChatMemberRole
}

export type ChatDetailPayload = {
  chat: {
    id: string
    name: string | null
    type: string
    is_group: boolean
    invite_code: string | null
    my_role: ChatMemberRole
  }
  members: ChatDetailMember[]
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
  _myUserId: string,
  peerUserId: string
): Promise<ApiChatRow> {
  const res = await fetch(`${API_URL}/chats`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'direct_e2e',
      member_ids: [canonicalUserId(peerUserId)],
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
      members: params.members.map((m) => ({
        ...m,
        userId: canonicalUserId(m.userId),
      })),
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
  return c.member_ids.filter(
    (id) => canonicalUserId(id) !== canonicalUserId(myUserId)
  )
}

export async function leaveChat(chatId: string): Promise<void> {
  const r = await fetch(`${API_URL}/chats/${chatId}/leave`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'LEAVE_FAILED')
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  const r = await fetch(`${API_URL}/chats/${chatId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'DELETE_FAILED')
  }
}

export async function fetchChatDetail(chatId: string): Promise<ChatDetailPayload> {
  const res = await fetch(`${API_URL}/chats/${chatId}`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as
    | ChatDetailPayload
    | { error?: string }
  if (!res.ok) {
    throw new Error(
      'error' in data && data.error ? data.error : 'CHAT_DETAIL_FAILED'
    )
  }
  return data as ChatDetailPayload
}

export async function ensureGroupInviteCode(chatId: string): Promise<string> {
  const res = await fetch(`${API_URL}/chats/${chatId}/invite`, {
    method: 'POST',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    invite_code?: string
    error?: string
  }
  if (!res.ok || !data.invite_code) {
    throw new Error(data.error ?? 'INVITE_CREATE_FAILED')
  }
  return data.invite_code
}

export async function joinChatByInviteCode(code: string): Promise<{
  chat_id: string
  already_member: boolean
}> {
  const trimmed = code.trim()
  const res = await fetch(
    `${API_URL}/chats/join/${encodeURIComponent(trimmed)}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as {
    chat_id?: string
    already_member?: boolean
    error?: string
  }
  if (!res.ok || !data.chat_id) {
    throw new Error(data.error ?? 'JOIN_FAILED')
  }
  return {
    chat_id: data.chat_id,
    already_member: Boolean(data.already_member),
  }
}

export async function patchChatMemberRole(
  chatId: string,
  targetUserId: string,
  role: ChatMemberRole
): Promise<void> {
  const r = await fetch(
    `${API_URL}/chats/${chatId}/members/${canonicalUserId(targetUserId)}/role`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }
  )
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'ROLE_PATCH_FAILED')
  }
}

export async function kickChatMember(
  chatId: string,
  targetUserId: string
): Promise<void> {
  const r = await fetch(
    `${API_URL}/chats/${chatId}/members/${canonicalUserId(targetUserId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
    }
  )
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'KICK_FAILED')
  }
}

export async function uploadMemberWrappedGroupKey(
  chatId: string,
  targetUserId: string,
  encryptedGroupKeyBase64: string
): Promise<void> {
  const r = await fetch(
    `${API_URL}/chats/${chatId}/members/${canonicalUserId(targetUserId)}/wrapped-key`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted_group_key: encryptedGroupKeyBase64 }),
    }
  )
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'WRAPPED_KEY_FAILED')
  }
}

export async function deleteMessage(
  messageId: string,
  forEveryone: boolean
): Promise<void> {
  const r = await fetch(`${API_URL}/messages/${messageId}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ for_everyone: forEveryone }),
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'DELETE_MSG_FAILED')
  }
}

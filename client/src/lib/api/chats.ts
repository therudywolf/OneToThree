import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { canonicalUserId } from '@/lib/user-id'

export type ChatMemberRole = 'owner' | 'admin' | 'member'

export type ApiChatRow = {
  id: string
  name: string | null
  type: string
  is_group: boolean
  member_ids: string[]
  /** True for Saved Messages (single-member direct_e2e with only the current user). */
  is_self?: boolean
  is_favorite?: boolean
  favorited_at?: string | null
  /**
   * ISO timestamp until which this chat is muted for the current user, or
   * null if not muted. A value in the past means the mute has expired and
   * the client should treat the chat as un-muted.
   */
  muted_until?: string | null
  /** Present for group_e2e: wrapped group key for the current user. */
  encrypted_group_key?: string | null
  /** ISO timestamp of the newest message in this chat, if any. */
  last_message_at?: string | null
  /** Group / public: server-side pack role. */
  my_role?: ChatMemberRole
  /** Channel: posting permission for the current user ('subscriber' | 'editor' | 'owner'). Non-null only for type === 'channel'. */
  my_channel_role?: 'subscriber' | 'editor' | 'owner' | null
  /** Group: invite slug when you may manage links. */
  invite_code?: string | null
  invite_slug?: string | null
  /** Server bump when group membership requires key rotation (group_e2e). */
  key_epoch?: number
  /** Unread delivery count for this device (messages delivered but not yet read). */
  unread_count?: number
}

/** Client-side helper: is this chat currently muted? */
export function isChatMuted(chat: Pick<ApiChatRow, 'muted_until'>): boolean {
  if (!chat.muted_until) return false
  const t = Date.parse(chat.muted_until)
  if (!Number.isFinite(t)) return false
  return t > Date.now()
}

/** Channel feed permission (server `channel_role` enum). */
export type ChannelFeedRole = 'subscriber' | 'editor' | 'owner'

export type ChatDetailMember = {
  user_id: string
  username: string
  ecdh_public_key_jwk: string | null
  avatar_key?: string | null
  encrypted_group_key: string | null
  role: ChatMemberRole
  channel_role?: ChannelFeedRole | null
}

export type ChatDetailPayload = {
  chat: {
    id: string
    name: string | null
    type: string
    is_group: boolean
    invite_code: string | null
    invite_slug?: string | null
    invite_one_time: boolean | null
    my_role: ChatMemberRole
    discussion_chat_id?: string | null
    /** Current key-rotation generation; compared against the stored key's epoch. */
    key_epoch?: number
  }
  members: ChatDetailMember[]
}

export async function fetchOrCreateSelfChat(): Promise<ApiChatRow> {
  const res = await fetchWithTimeout(`${API_URL}/chats/self`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ApiChatRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'SELF_CHAT_FAILED')
  }
  if (!data.chat?.id) {
    throw new Error('INVALID_SELF_CHAT_RESPONSE')
  }
  return data.chat
}

export async function fetchChatsList(): Promise<ApiChatRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/chats`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    chats?: ApiChatRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'CHATS_FETCH_FAILED')
  }
  return data.chats ?? []
}

export async function fetchFavoriteChatsList(): Promise<ApiChatRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/chats/favorites`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    chats?: ApiChatRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'FAVORITES_FETCH_FAILED')
  }
  return data.chats ?? []
}

export async function setChatFavorite(chatId: string, favorite: boolean): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/chats/${chatId}/favorite`, {
    method: favorite ? 'POST' : 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? (favorite ? 'FAVORITE_SET_FAILED' : 'FAVORITE_CLEAR_FAILED'))
  }
}

/**
 * Per-user chat mute toggle. Pass `null` to clear the mute, an ISO string to
 * set an explicit expiry, or `'forever'` for an effectively-permanent mute.
 */
export async function setChatMute(
  chatId: string,
  mutedUntil: string | 'forever' | null
): Promise<{ muted_until: string | null }> {
  const res = await fetchWithTimeout(`${API_URL}/chats/${chatId}/mute`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted_until: mutedUntil }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    muted_until?: string | null
  }
  if (!res.ok) throw new Error(data.error ?? 'MUTE_FAILED')
  return { muted_until: data.muted_until ?? null }
}

export async function createDirectE2EChat(
  _myUserId: string,
  peerUserId: string
): Promise<ApiChatRow> {
  const res = await fetchWithTimeout(`${API_URL}/chats`, {
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
  const res = await fetchWithTimeout(`${API_URL}/chats`, {
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

export async function createPublicOpenChat(params: {
  name: string
  memberIds: string[]
}): Promise<ApiChatRow> {
  const res = await fetchWithTimeout(`${API_URL}/chats`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'public_open',
      name: params.name.trim() || null,
      member_ids: params.memberIds.map(canonicalUserId),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ApiChatRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'PUBLIC_GROUP_CREATE_FAILED')
  }
  if (!data.chat?.id) {
    throw new Error('INVALID_PUBLIC_GROUP_RESPONSE')
  }
  return data.chat
}

export async function createChannelChat(params: {
  name: string
  memberIds: string[]
}): Promise<ApiChatRow> {
  const res = await fetchWithTimeout(`${API_URL}/chats`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'channel',
      name: params.name.trim() || null,
      member_ids: params.memberIds.map(canonicalUserId),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ApiChatRow
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'CHANNEL_CREATE_FAILED')
  }
  if (!data.chat?.id) {
    throw new Error('INVALID_CHANNEL_RESPONSE')
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
  const r = await fetchWithTimeout(`${API_URL}/chats/${chatId}/leave`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'LEAVE_FAILED')
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  const r = await fetchWithTimeout(`${API_URL}/chats/${chatId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'DELETE_FAILED')
  }
}

export async function fetchChatDetail(chatId: string): Promise<ChatDetailPayload> {
  const res = await fetchWithTimeout(`${API_URL}/chats/${chatId}`, {
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

export async function ensureGroupInviteCode(
  chatId: string,
  opts?: { invite_one_time?: boolean }
): Promise<string> {
  const res = await fetchWithTimeout(`${API_URL}/chats/${chatId}/invite`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body:
      opts?.invite_one_time !== undefined
        ? JSON.stringify({ invite_one_time: opts.invite_one_time })
        : undefined,
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

export async function patchInviteSlug(chatId: string, inviteSlug: string): Promise<string> {
  const trimmed = inviteSlug.trim().toLowerCase()
  const r = await fetchWithTimeout(`${API_URL}/chats/${chatId}/invite-slug`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_slug: trimmed }),
  })
  const data = (await r.json().catch(() => ({}))) as { invite_slug?: string; error?: string }
  if (!r.ok || !data.invite_slug) {
    throw new Error(data.error ?? 'INVITE_SLUG_PATCH_FAILED')
  }
  return data.invite_slug
}

export async function joinChatByInviteCode(code: string): Promise<{
  chat_id: string
  already_member: boolean
}> {
  const trimmed = code.trim()
  const res = await fetchWithTimeout(
    `${API_URL}/chats/join/${encodeURIComponent(trimmed)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }
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
  const r = await fetchWithTimeout(
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

/** Link a discussion group chat to a channel (or clear). Server route may be absent until deployed. */
export async function patchDiscussionChat(
  chatId: string,
  discussionChatId: string | null
): Promise<void> {
  const r = await fetchWithTimeout(`${API_URL}/chats/${chatId}/discussion`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discussion_chat_id: discussionChatId }),
  })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'DISCUSSION_PATCH_FAILED')
  }
}

export async function patchChannelMemberFeedRole(
  chatId: string,
  targetUserId: string,
  role: ChannelFeedRole
): Promise<void> {
  const r = await fetchWithTimeout(
    `${API_URL}/chats/${chatId}/members/${canonicalUserId(targetUserId)}/channel-role`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_role: role }),
    }
  )
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'CHANNEL_ROLE_PATCH_FAILED')
  }
}

export async function kickChatMember(
  chatId: string,
  targetUserId: string
): Promise<void> {
  const r = await fetchWithTimeout(
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
  const r = await fetchWithTimeout(
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
  const r = await fetchWithTimeout(`${API_URL}/messages/${messageId}`, {
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

export type DiscoverChatRow = {
  id: string
  name: string | null
  type: string
  invite_code: string | null
  invite_slug?: string | null
  member_count: number
}

export async function discoverChats(opts?: { q?: string; limit?: number; offset?: number }): Promise<DiscoverChatRow[]> {
  const params = new URLSearchParams()
  if (opts?.q) params.set('q', opts.q)
  if (opts?.limit != null) params.set('limit', String(opts.limit))
  if (opts?.offset != null) params.set('offset', String(opts.offset))
  const qs = params.toString()
  const r = await fetchWithTimeout(`${API_URL}/chats/discover${qs ? `?${qs}` : ''}`, { credentials: 'include' })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(d.error ?? 'DISCOVER_FAILED')
  }
  return (await r.json()) as DiscoverChatRow[]
}

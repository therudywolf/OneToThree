import { API_URL } from './auth'
import { canonicalUserId } from '@/lib/user-id'

export type SearchUserRow = {
  id: string
  username: string
  public_key_jwk: string
  ecdh_public_key_jwk: string | null
}

export async function searchUsers(query: string): Promise<SearchUserRow[]> {
  const q = query.trim()
  if (!q) return []
  const res = await fetch(
    `${API_URL}/users/search?q=${encodeURIComponent(q)}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => [])) as SearchUserRow[] | { error?: string }
  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : 'SEARCH_FAILED'
    )
  }
  return Array.isArray(data) ? data : []
}

export type UserLookupRow = {
  id: string
  username: string
  ecdh_public_key_jwk: string | null
  avatar_key?: string | null
}

export type PresenceRow = {
  id: string
  online: boolean
  last_seen_at: string | null
}

export async function fetchUserPresence(
  userIds: string[]
): Promise<PresenceRow[]> {
  const unique = Array.from(
    new Set(userIds.map((id) => canonicalUserId(id)))
  )
  if (unique.length === 0) return []
  const res = await fetch(`${API_URL}/users/presence`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: unique }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    users?: PresenceRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'PRESENCE_FAILED')
  }
  return data.users ?? []
}

export async function lookupUsers(userIds: string[]): Promise<UserLookupRow[]> {
  const unique = Array.from(
    new Set(userIds.map((id) => canonicalUserId(id)))
  )
  if (unique.length === 0) return []
  const res = await fetch(`${API_URL}/users/lookup`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: unique }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    users?: UserLookupRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'LOOKUP_FAILED')
  }
  return data.users ?? []
}

export async function patchMyEcdhPublicKey(
  ecdh_public_key_jwk: string
): Promise<void> {
  const res = await fetch(`${API_URL}/users/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ecdh_public_key_jwk }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PATCH_ECDH_FAILED')
  }
}

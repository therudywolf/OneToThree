import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { canonicalUserId } from '@/lib/user-id'
import { importEcdsaPrivateKeyForSign, signUtf8WithEcdsaP256 } from '@/lib/crypto'

export type SearchUserRow = {
  id: string
  username: string
  public_key_jwk: string
  ecdh_public_key_jwk: string | null
}

export async function searchUsers(query: string): Promise<SearchUserRow[]> {
  const q = query.trim()
  if (!q) return []
  const res = await fetchWithTimeout(
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
  const res = await fetchWithTimeout(`${API_URL}/users/presence`, {
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
  const res = await fetchWithTimeout(`${API_URL}/users/lookup`, {
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

export type UserProfile = {
  username: string
  display_name: string | null
  avatar_key: string | null
  bio: string | null
  status_text: string | null
  social_links: Array<{ platform: string; url: string }>
  online: boolean
  last_seen_at: string | null
  mutual_groups?: Array<{ id: string; name: string }>
  /** Personal channel pinned to the profile; null/absent when not linked or not joinable. */
  profile_channel?: {
    id: string
    name: string
    description: string | null
    avatar_key: string | null
    invite_slug: string | null
    invite_code: string | null
    member_count: number
  } | null
}

export async function fetchUserProfile(username: string): Promise<UserProfile> {
  const res = await fetchWithTimeout(
    `${API_URL}/users/${encodeURIComponent(username)}/profile`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as UserProfile & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PROFILE_FAILED')
  }
  return data
}

export type BlockedUserRow = {
  user_id: string
  username: string
  avatar_key: string | null
  blocked_at: string
}

export async function fetchBlockedUsers(): Promise<BlockedUserRow[]> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/blocked`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    blocked?: BlockedUserRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'BLOCKED_LIST_FAILED')
  }
  return data.blocked ?? []
}

export async function blockUser(targetId: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${API_URL}/users/me/block/${canonicalUserId(targetId)}`,
    { method: 'POST', credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'BLOCK_FAILED')
  }
}

export async function unblockUser(targetId: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${API_URL}/users/me/block/${canonicalUserId(targetId)}`,
    { method: 'DELETE', credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'UNBLOCK_FAILED')
  }
}

export type ProfilePatch = {
  bio?: string
  status_text?: string
  display_name?: string
  last_seen_privacy?: 'everyone' | 'contacts' | 'nobody'
  social_links?: Array<{ platform: string; url: string }>
  /** Personal channel pinned to the profile; null unlinks. */
  profile_channel_id?: string | null
}

export async function patchMyProfile(patch: ProfilePatch): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/users/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PROFILE_PATCH_FAILED')
  }
}

/** Single-use nonce for the ECDH-publish vault proof. */
export async function getEcdhPublishChallenge(): Promise<string> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/ecdh/publish-challenge`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as { nonce?: string; error?: string }
  if (!res.ok || !data.nonce) {
    throw new Error(data.error ?? 'ECDH_CHALLENGE_FAILED')
  }
  return data.nonce
}

/**
 * Publish this device's ECDH public key.
 *
 * Requires a VAULT-UNLOCK PROOF: `ecdsaPrivateJwk` is the keyring's signing key,
 * which only exists after the vault password has unlocked the keyring. The
 * server refuses the write without it, because this key is what every peer
 * encrypts to — with only a session cookie behind it, a stolen session could
 * swap in an attacker's key and silently redirect the victim's incoming
 * messages, no vault password needed.
 */
/**
 * The last key this tab successfully published.
 *
 * Registration reaches this function TWICE within a second — once from
 * crypto-login right after /auth/verify, once from activateVaultSession — with
 * the same key. Both did the full challenge→sign→PATCH dance, which doubled the
 * challenge spend per sign-in and, before the server was taught to keep more
 * than one outstanding nonce, made the two attempts cancel each other so the key
 * was never published at all. One publish per key per tab is enough.
 */
let lastPublishedEcdhJwk: string | null = null

/** Force a re-publish on the next call (account switch, vault re-import). */
export function resetEcdhPublishCache(): void {
  lastPublishedEcdhJwk = null
}

export async function patchMyEcdhPublicKey(
  ecdh_public_key_jwk: string,
  ecdsaPrivateJwk: string
): Promise<void> {
  if (lastPublishedEcdhJwk === ecdh_public_key_jwk) return
  const nonce = await getEcdhPublishChallenge()
  const signingKey = await importEcdsaPrivateKeyForSign(ecdsaPrivateJwk)
  const proof_signature = await signUtf8WithEcdsaP256(signingKey, nonce)

  const res = await fetchWithTimeout(`${API_URL}/users/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ecdh_public_key_jwk,
      proof_nonce: nonce,
      proof_signature,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.ok) {
    lastPublishedEcdhJwk = ecdh_public_key_jwk
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'PATCH_ECDH_FAILED')
  }
}

/**
 * D7 — outcome of a `DELETE /users/me/account` attempt. The server requires a
 * username confirmation AND, when TOTP is enabled, a step-up code supplied via
 * the `X-TOTP-Code` header. The caller surfaces `totp_required` by prompting
 * for a 6-digit code and retrying.
 */
export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; reason: 'totp_required' | 'totp_invalid'; error: string }
  | { ok: false; reason: 'error'; error: string }

/**
 * Permanently delete the signed-in account (server-side: tombstones messages,
 * drops devices/blocks/push subscriptions, scrubs media). Mirrors the recovery
 * step-up convention — pass `totpCode` to retry once TOTP is challenged.
 */
export async function deleteMyAccount(params: {
  confirm_username: string
  totpCode?: string
}): Promise<DeleteAccountResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const code = params.totpCode?.trim()
  if (code) headers['X-TOTP-Code'] = code
  let res: Response
  try {
    res = await fetchWithTimeout(`${API_URL}/users/me/account`, {
      method: 'DELETE',
      credentials: 'include',
      headers,
      body: JSON.stringify({ confirm_username: params.confirm_username }),
    })
  } catch (err) {
    return { ok: false, reason: 'error', error: err instanceof Error ? err.message : 'NETWORK' }
  }
  if (res.ok) return { ok: true }
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  const error = data.error ?? `DELETE_ACCOUNT_${res.status}`
  if (error === 'TOTP_STEP_UP_REQUIRED') return { ok: false, reason: 'totp_required', error }
  if (error === 'TOTP_INVALID' || error === 'TOTP_ALREADY_USED') {
    return { ok: false, reason: 'totp_invalid', error }
  }
  return { ok: false, reason: 'error', error }
}

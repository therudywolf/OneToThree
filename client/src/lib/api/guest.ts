// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * One-time guest links API (docs/project/GUEST_MODE_CONCEPT.ru.md).
 *
 * Public half (no session): resolve / knock / poll / cancel / enter — used by
 * the /guest/call/[token] and /guest/chat/[token] entry pages.
 * Authenticated half: invite CRUD, knock approve/deny, kick, guest self-leave.
 */

import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'

async function jsonOrThrow<T>(res: Response, fallbackError: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? fallbackError)
  return data
}

// ─── Public (guest side) ────────────────────────────────────────────────────

export type GuestResolveResponse = {
  kind: 'call' | 'chat'
  host_name: string
  can_join: boolean
}

export async function resolveGuestToken(token: string): Promise<GuestResolveResponse> {
  const res = await fetchWithTimeout(`${API_URL}/guest/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return jsonOrThrow<GuestResolveResponse>(res, 'INVITE_NOT_FOUND')
}

export type GuestKnockCreated = {
  knock_id: string
  knock_secret: string
  poll_interval_s: number
  ttl_s: number
}

export async function guestKnock(token: string, nickname: string): Promise<GuestKnockCreated> {
  const res = await fetchWithTimeout(`${API_URL}/guest/knock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, nickname }),
  })
  return jsonOrThrow<GuestKnockCreated>(res, 'KNOCK_FAILED')
}

export type GuestKnockStatus =
  | { status: 'pending' }
  | { status: 'denied' }
  | {
      status: 'approved'
      room: string
      identity: string
      livekit_url: string
      token: string
      call_e2ee_key: string
    }

export async function pollGuestKnock(id: string, secret: string): Promise<GuestKnockStatus> {
  const res = await fetchWithTimeout(
    `${API_URL}/guest/knock/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`,
    { timeoutMs: 8_000 }
  )
  return jsonOrThrow<GuestKnockStatus>(res, 'KNOCK_NOT_FOUND')
}

export async function cancelGuestKnock(id: string, secret: string): Promise<void> {
  await fetchWithTimeout(`${API_URL}/guest/knock/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  }).catch(() => {})
}

export type GuestEnterResponse = {
  username: string
  user_id: string
  chat_id: string
  expires_at: string
}

export async function guestEnter(params: {
  token: string
  nickname: string
  publicKeyJwk: string
  ecdhPublicKeyJwk: string
}): Promise<GuestEnterResponse> {
  const res = await fetchWithTimeout(`${API_URL}/guest/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: params.token,
      nickname: params.nickname,
      public_key_jwk: params.publicKeyJwk,
      ecdh_public_key_jwk: params.ecdhPublicKeyJwk,
    }),
  })
  return jsonOrThrow<GuestEnterResponse>(res, 'ENTER_FAILED')
}

// ─── Authenticated (creator side + guest self-destruct) ─────────────────────

export type GuestInvite = {
  id: string
  token: string
  purpose: 'call' | 'chat'
  chat_id: string | null
  room_id: string | null
  can_publish: boolean
  /** Seats: how many guests this link admits in total (1 = one-time). */
  max_uses: number
  used_count: number
  /** No seats left — the link cannot admit anyone new (its room may be live). */
  exhausted: boolean
  expires_at: string
  created_at?: string
  path: string
}

export function guestInviteUrl(invite: Pick<GuestInvite, 'path'>): string {
  if (typeof window === 'undefined') return invite.path
  return `${window.location.origin}${invite.path}`
}

export async function createGuestInvite(params: {
  purpose: 'call' | 'chat'
  chatId?: string
  canPublish?: boolean
  /** Seats. Omit for the server default (1 for a chat, several for a meeting). */
  maxUses?: number
}): Promise<GuestInvite> {
  const res = await fetchWithTimeout(`${API_URL}/guest-invites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose: params.purpose,
      ...(params.chatId ? { chat_id: params.chatId } : {}),
      ...(params.canPublish === undefined ? {} : { can_publish: params.canPublish }),
      ...(params.maxUses === undefined ? {} : { max_uses: params.maxUses }),
    }),
  })
  return jsonOrThrow<GuestInvite>(res, 'INVITE_CREATE_FAILED')
}

/**
 * Where the CREATOR goes to be in the meeting their link points at:
 * a chat-bound link opens that chat's call, a standalone room has its own page.
 */
export function meetingHref(invite: GuestInvite): string | null {
  if (invite.purpose !== 'call') return null
  if (invite.chat_id) return `/?chat=${encodeURIComponent(invite.chat_id)}`
  // Both land in the app shell with its ordinary call UI — the stripped-down
  // room screen is the GUEST's, who has no app to run. `/meet/<room>` still
  // works (it redirects here) for links already handed out.
  if (invite.room_id) return `/?meet=${encodeURIComponent(invite.room_id)}`
  return null
}

/**
 * Signed-in view of where a guest link goes (#6).
 *
 * `member: true` means this account can open the target directly — it is a
 * member of that chat, or it created a standalone meeting. Everyone else is
 * told nothing but "no", and knocks like any other guest.
 *
 * Never throws for the not-signed-in case: the guest pages call this
 * speculatively on load, and "no session" is the normal answer, not an error.
 */
export type GuestLinkTarget = {
  kind: 'call' | 'chat'
  /** The CALLER's own username — what "войти как …" is offered under. */
  username: string
  member: boolean
  chat_id?: string
  room_id?: string
}

export async function resolveGuestLinkTarget(
  token: string
): Promise<GuestLinkTarget | null> {
  try {
    const res = await fetchWithTimeout(`${API_URL}/guest/link-target`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return null
    return (await res.json()) as GuestLinkTarget
  } catch {
    return null
  }
}

/**
 * Open the temp chat as the account you already have, instead of minting a
 * throwaway guest one (#6). Returns the direct chat's id.
 */
export async function guestEnterAsMe(
  token: string
): Promise<{ chat_id: string; existing: boolean }> {
  const res = await fetchWithTimeout(`${API_URL}/guest/enter-as-me`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return jsonOrThrow<{ chat_id: string; existing: boolean }>(res, 'ENTER_AS_ME_FAILED')
}

export async function listGuestInvites(): Promise<GuestInvite[]> {
  const res = await fetchWithTimeout(`${API_URL}/guest-invites`, {
    credentials: 'include',
  })
  const data = await jsonOrThrow<{ invites: GuestInvite[] }>(res, 'INVITES_LIST_FAILED')
  return data.invites ?? []
}

export async function revokeGuestInvite(id: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest-invites/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'REVOKE_FAILED')
}

/**
 * Revoke every live link at once. Returns how many were still open, so the UI
 * can say "отозвано 7" instead of a silent refresh — the difference matters
 * when the user pressed it because a link leaked.
 *
 * Revoking stops NEW guests from entering; it does not end a meeting already in
 * progress (for that, kick the guests who are in it).
 */
export async function revokeAllGuestInvites(): Promise<number> {
  const res = await fetchWithTimeout(`${API_URL}/guest-invites`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const data = await jsonOrThrow<{ ok: boolean; revoked?: number }>(
    res,
    'REVOKE_ALL_FAILED'
  )
  return data.revoked ?? 0
}

export type GuestPendingKnock = {
  knock_id: string
  nickname: string
  chat_id: string | null
  room_id: string
  /** End of the knock's 5-minute window; optional — an older server omits it. */
  expires_at?: string | null
}

/**
 * Knocks still waiting for THIS user's answer.
 *
 * `guest_knock` is a broadcast and nothing more: a knock raised while the host
 * had no live socket goes out to zero sockets, and the push that follows it
 * («Гость стучится во встречу — откройте, чтобы впустить») used to open a screen
 * that only ever listened for the NEXT knock. The overlay pulls this on mount
 * and after every reconnect so the card the host was pushed about is actually
 * there when they arrive.
 */
export async function listPendingGuestKnocks(): Promise<GuestPendingKnock[]> {
  const res = await fetchWithTimeout(`${API_URL}/guest/knocks`, {
    credentials: 'include',
  })
  const data = await jsonOrThrow<{ knocks: GuestPendingKnock[] }>(res, 'KNOCKS_LIST_FAILED')
  return data.knocks ?? []
}

export async function approveGuestKnock(id: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest/knock/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    credentials: 'include',
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'APPROVE_FAILED')
}

export async function denyGuestKnock(id: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest/knock/${encodeURIComponent(id)}/deny`, {
    method: 'POST',
    credentials: 'include',
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'DENY_FAILED')
}

/**
 * Remove a guest from a live call.
 *
 * The denylist write and the LiveKit removal are two different things, and only
 * the first one always happens: when the SFU call fails the server answers
 * `removed: false` (older builds, with a 200) or 502 KICK_NOT_APPLIED. Both mean
 * the same to the host — the guest is still sitting in the room and the kick has
 * to be retried — so both throw. Reading `ok` alone reported those as success and
 * the tile just stayed there with no explanation.
 */
export async function kickGuestFromCall(room: string, identity: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest-calls/kick`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, identity }),
  })
  const data = await jsonOrThrow<{ ok: boolean; removed?: boolean }>(res, 'KICK_FAILED')
  if (data.removed === false) throw new Error('KICK_NOT_APPLIED')
}

/**
 * Host side of ending a temp chat early: purges the guest account AND the chat.
 * The guest could always leave; without this the person who handed out the link
 * had to wait out the TTL.
 */
export async function endGuestChat(chatId: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${API_URL}/guest-chats/${encodeURIComponent(chatId)}/kick`,
    { method: 'POST', credentials: 'include' }
  )
  await jsonOrThrow<{ ok: boolean }>(res, 'END_CHAT_FAILED')
}

/** Guest self-destruct: purge the ephemeral account and the temp chat now. */
export async function guestLeave(): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest/me/leave`, {
    method: 'POST',
    credentials: 'include',
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'LEAVE_FAILED')
}

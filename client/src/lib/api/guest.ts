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
}): Promise<GuestInvite> {
  const res = await fetchWithTimeout(`${API_URL}/guest-invites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose: params.purpose,
      ...(params.chatId ? { chat_id: params.chatId } : {}),
      ...(params.canPublish === undefined ? {} : { can_publish: params.canPublish }),
    }),
  })
  return jsonOrThrow<GuestInvite>(res, 'INVITE_CREATE_FAILED')
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

export async function kickGuestFromCall(room: string, identity: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest-calls/kick`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, identity }),
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'KICK_FAILED')
}

/** Guest self-destruct: purge the ephemeral account and the temp chat now. */
export async function guestLeave(): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/guest/me/leave`, {
    method: 'POST',
    credentials: 'include',
  })
  await jsonOrThrow<{ ok: boolean }>(res, 'LEAVE_FAILED')
}

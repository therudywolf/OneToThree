import {
  authDeviceHeaders,
  getOrCreateClientDeviceId,
} from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { canonicalUserId } from '@/lib/user-id'

/**
 * Browser calls to the Fastify API (cross-origin; session cookie is host-scoped to API origin).
 */

/**
 * Same-origin `/api` (Next rewrites → Fastify) so `fm_session` is set on the page origin.
 * Set `NEXT_PUBLIC_API_URL=http://localhost:8080` only if you intentionally bypass the proxy.
 */
function normalizeApiRoot(): string {
  const raw =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL?.trim()
      : undefined
  if (!raw || raw === 'same-origin') {
    return '/api'
  }
  const base = raw.replace(/\/$/, '')
  return `${base}/api`
}

export const API_URL = normalizeApiRoot()

/** Thrown when `/auth/me` or other auth API calls fail; includes HTTP status for 401 handling. */
export class AuthHttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthHttpError'
    this.status = status
  }
}

export async function requestChallenge(username: string): Promise<{ nonce: string }> {
  const res = await fetch(`${API_URL}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: username.trim() }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    nonce?: string
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'CHALLENGE_FAILED')
  }
  if (!data.nonce) {
    throw new Error('INVALID_CHALLENGE_RESPONSE')
  }
  return { nonce: data.nonce }
}

export type VerifyChallengePayload = {
  username: string
  nonce: string
  signature: string
  public_key_jwk?: string
}

export type VerifyChallengeResult =
  | { kind: 'session'; user: { id: string; username: string } }
  | { kind: '2fa_pending'; pendingToken: string; userId: string }

export async function verifyChallenge(
  payload: VerifyChallengePayload
): Promise<VerifyChallengeResult> {
  const res = await fetch(`${API_URL}/auth/verify`, {
    method: 'POST',
    headers: sanitizeFetchHeaderRecord({
      'Content-Type': 'application/json',
      ...authDeviceHeaders(),
    }),
    credentials: 'include',
    body: JSON.stringify({
      username: payload.username.trim(),
      nonce: payload.nonce,
      signature: payload.signature,
      ...(payload.public_key_jwk
        ? { public_key_jwk: payload.public_key_jwk }
        : {}),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id: string; username: string }
    requires2FA?: boolean
    pendingToken?: string
    userId?: string
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'VERIFY_FAILED')
  }
  if (
    data.requires2FA === true &&
    data.pendingToken &&
    data.userId
  ) {
    return {
      kind: '2fa_pending',
      pendingToken: data.pendingToken,
      userId: canonicalUserId(data.userId),
    }
  }
  if (data.user?.id && data.user.username) {
    return {
      kind: 'session',
      user: {
        id: canonicalUserId(data.user.id),
        username: data.user.username,
      },
    }
  }
  throw new Error('INVALID_VERIFY_RESPONSE')
}

export async function complete2faLogin(
  pendingToken: string,
  code: string
): Promise<{ user: { id: string; username: string } }> {
  const res = await fetch(`${API_URL}/auth/login/2fa`, {
    method: 'POST',
    headers: sanitizeFetchHeaderRecord({
      'Content-Type': 'application/json',
      ...authDeviceHeaders(),
    }),
    credentials: 'include',
    body: JSON.stringify({
      pending_token: pendingToken,
      code: code.trim(),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id: string; username: string }
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'TOTP_VERIFY_FAILED')
  }
  if (!data.user?.id || !data.user.username) {
    throw new Error('INVALID_2FA_RESPONSE')
  }
  return {
    user: {
      id: canonicalUserId(data.user.id),
      username: data.user.username,
    },
  }
}

export async function fetchMe(): Promise<{
  user: {
    id: string
    username: string
    is_discoverable?: boolean
    role?: 'user' | 'admin'
    totp_enabled?: boolean
    device_id?: string | null
    avatar_key?: string | null
  }
}> {
  const res = await fetch(`${API_URL}/auth/me`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: {
      id: string
      username: string
      is_discoverable?: boolean
      role?: 'user' | 'admin'
      totp_enabled?: boolean
      device_id?: string | null
      avatar_key?: string | null
    }
    error?: string
  }
  if (!res.ok) {
    if (process.env.NODE_ENV !== 'production' && res.status === 401) {
      console.warn('[auth] /me unauthorized', res.status)
    }
    throw new AuthHttpError(data.error ?? 'UNAUTHORIZED', res.status)
  }
  if (!data.user?.id) {
    throw new Error('INVALID_ME_RESPONSE')
  }
  return {
    user: {
      ...data.user,
      id: canonicalUserId(data.user.id),
      is_discoverable:
        typeof data.user.is_discoverable === 'boolean'
          ? data.user.is_discoverable
          : false,
      role: data.user.role === 'admin' ? 'admin' : 'user',
      totp_enabled:
        typeof data.user.totp_enabled === 'boolean'
          ? data.user.totp_enabled
          : false,
      device_id:
        typeof data.user.device_id === 'string' ? data.user.device_id : null,
      avatar_key:
        typeof data.user.avatar_key === 'string' ? data.user.avatar_key : null,
    },
  }
}

/** Ensure device id exists before auth (call early on login page). */
export function ensureClientDeviceId(): void {
  getOrCreateClientDeviceId()
}

export async function logoutApi(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
}

/** Short-lived JWT for WebSocket when the upgrade cannot send cookies. */
export async function fetchWsTicket(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/ws-ticket`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    ticket?: string
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'WS_TICKET_FAILED')
  }
  if (!data.ticket) {
    throw new Error('INVALID_WS_TICKET')
  }
  return data.ticket
}

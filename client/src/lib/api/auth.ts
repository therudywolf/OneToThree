import { fetchWithTimeout } from '@/lib/api/fetch'
import {
  authDeviceHeaders,
  getOrCreateClientDeviceId,
} from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { canonicalUserId } from '@/lib/user-id'
import { clearNativeSessionCookie, warmNativeSessionCookies } from '@/lib/native-session'

/**
 * Browser calls to the Fastify API (cross-origin; session cookie is host-scoped to API origin).
 */

/**
 * Same-origin `/api` when `NEXT_PUBLIC_API_URL` is unset (Next rewrites → Fastify; session on page origin).
 * Otherwise `${NEXT_PUBLIC_API_URL}/api` for a dedicated API host — must be a **public** origin in production.
 * Development-only: set `NEXT_PUBLIC_API_URL=http://localhost:8080` to bypass the Next proxy.
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
  const res = await fetchWithTimeout(`${API_URL}/auth/challenge`, {
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
  const res = await fetchWithTimeout(`${API_URL}/auth/verify`, {
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
    await warmNativeSessionCookies()
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
): Promise<{ user: { id: string; username: string }; vault_blob?: string }> {
  const res = await fetchWithTimeout(`${API_URL}/auth/login/2fa`, {
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
    vault_blob?: string
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'TOTP_VERIFY_FAILED')
  }
  if (!data.user?.id || !data.user.username) {
    throw new Error('INVALID_2FA_RESPONSE')
  }
  await warmNativeSessionCookies()
  const user = {
    id: canonicalUserId(data.user.id),
    username: data.user.username,
  }
  return {
    user,
    ...(typeof data.vault_blob === 'string' && data.vault_blob.trim()
      ? { vault_blob: data.vault_blob }
      : {}),
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
  await warmNativeSessionCookies()
  const res = await fetchWithTimeout(`${API_URL}/auth/me`, {
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
  await fetchWithTimeout(`${API_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
  await clearNativeSessionCookie()
}

/** Drop the session cookie without auth. Used on login page to clear stale sessions. */
export async function clearSessionApi(): Promise<void> {
  await fetchWithTimeout(`${API_URL}/auth/clear-session`, {
    method: 'POST',
    credentials: 'include',
  })
  await clearNativeSessionCookie()
}

/** Short-lived JWT for WebSocket when the upgrade cannot send cookies. */
export async function fetchWsTicket(): Promise<string> {
  const res = await fetchWithTimeout(`${API_URL}/auth/ws-ticket`, {
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

export async function setupRecoveryKey(totpCode?: string): Promise<{ recovery_key: string; recovery_key_set_at: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const code = totpCode?.trim()
  if (code) headers['X-TOTP-Code'] = code
  const res = await fetchWithTimeout(`${API_URL}/auth/recovery/setup`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord(headers),
  })
  const data = (await res.json().catch(() => ({}))) as {
    recovery_key?: string
    recovery_key_set_at?: string
    error?: string
  }
  if (!res.ok || !data.recovery_key || !data.recovery_key_set_at) {
    throw new Error(data.error ?? 'RECOVERY_SETUP_FAILED')
  }
  return {
    recovery_key: data.recovery_key,
    recovery_key_set_at: data.recovery_key_set_at,
  }
}

export async function verifyRecoveryKey(recoveryKey: string, totpCode?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const code = totpCode?.trim()
  if (code) headers['X-TOTP-Code'] = code
  const res = await fetchWithTimeout(`${API_URL}/auth/recovery/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord(headers),
    body: JSON.stringify({ recovery_key: recoveryKey }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'RECOVERY_VERIFY_FAILED')
  }
}

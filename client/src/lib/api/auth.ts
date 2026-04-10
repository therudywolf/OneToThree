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

export async function verifyChallenge(
  payload: VerifyChallengePayload
): Promise<{ user: { id: string; username: string } }> {
  const res = await fetch(`${API_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'VERIFY_FAILED')
  }
  if (!data.user?.id || !data.user.username) {
    throw new Error('INVALID_VERIFY_RESPONSE')
  }
  return {
    user: {
      id: canonicalUserId(data.user.id),
      username: data.user.username,
    },
  }
}

export async function fetchMe(): Promise<{
  user: { id: string; username: string; is_discoverable?: boolean }
}> {
  const res = await fetch(`${API_URL}/auth/me`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id: string; username: string; is_discoverable?: boolean }
    error?: string
  }
  if (!res.ok) {
    if (res.status === 401) {
      console.error(
        '[AUTH] Session invalid — wiping local state before redirect to login [Phase 18]',
        { status: res.status, error: data.error }
      )
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
    },
  }
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

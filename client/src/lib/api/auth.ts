/**
 * Browser calls to the Fastify API (cross-origin; session cookie is host-scoped to API origin).
 */

function normalizeApiRoot(): string {
  const raw =
    (typeof process !== 'undefined' &&
      process.env.NEXT_PUBLIC_API_URL?.trim()) ||
    'http://localhost:8080'
  const base = raw.replace(/\/$/, '')
  return `${base}/api`
}

export const API_URL = normalizeApiRoot()

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
  return { user: data.user }
}

export async function fetchMe(): Promise<{ user: { id: string; username: string } }> {
  const res = await fetch(`${API_URL}/auth/me`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id: string; username: string }
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'UNAUTHORIZED')
  }
  if (!data.user?.id) {
    throw new Error('INVALID_ME_RESPONSE')
  }
  return { user: data.user }
}

export async function logoutApi(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
}

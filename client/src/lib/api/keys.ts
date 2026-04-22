/**
 * Client for /api/keys/* (Double Ratchet / X3DH key directory).
 *
 * All keys are transported as base64url strings matching the server's
 * validation regexes. Responses are parsed into the same shape the ratchet
 * library expects.
 */
import { API_URL } from './auth'

export interface BundleResponse {
  user_id: string
  identity: {
    signing_public_key: string
    exchange_public_key: string
    generation: number
  }
  signed_prekey: {
    pre_key_id: number
    public_key: string
    signature: string
  }
  one_time_prekey: null | {
    pre_key_id: number
    public_key: string
  }
}

export interface PublishIdentityInput {
  signing_public_key: string
  exchange_public_key: string
  generation: number
}

export interface PublishSignedPrekeyInput {
  pre_key_id: number
  public_key: string
  signature: string
}

export interface PublishOneTimeInput {
  keys: Array<{ pre_key_id: number; public_key: string }>
}

async function postJson<T>(
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((data.error as string) ?? 'KEYS_REQUEST_FAILED')
  }
  return data as T
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((data.error as string) ?? 'KEYS_REQUEST_FAILED')
  }
  return data as T
}

export function publishIdentity(input: PublishIdentityInput) {
  return postJson<{ ok: true }>('/keys/identity', input)
}

export function publishSignedPrekey(input: PublishSignedPrekeyInput) {
  return postJson<{ ok: true }>('/keys/signed-prekey', input)
}

export function publishOneTimePrekeys(input: PublishOneTimeInput) {
  return postJson<{ ok: true; stored: number }>('/keys/one-time', input)
}

export function fetchInventory() {
  return getJson<{ one_time_prekeys: number; max: number }>('/keys/inventory')
}

export function fetchBundle(userId: string) {
  return getJson<BundleResponse>(`/keys/bundle/${userId}`)
}

import { fetchWithTimeout } from '@/lib/api/fetch'
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
    exchange_public_key_signature: string
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
  exchange_public_key_signature: string
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
  const res = await fetchWithTimeout(`${API_URL}${path}`, {
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
  const res = await fetchWithTimeout(`${API_URL}${path}`, { credentials: 'include' })
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

/**
 * Fetch an X3DH pre-key bundle for one user. With `deviceId` the server
 * returns that specific device's bundle (and pops one of ITS one-time
 * prekeys); without it the server falls back to the most recently published
 * device. Per-device Double Ratchet always passes an explicit `deviceId`.
 */
export function fetchBundle(userId: string, deviceId?: string) {
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return getJson<BundleResponse>(`/keys/bundle/${userId}${qs}`)
}

export interface DeviceIdentity {
  device_id: string
  identity: {
    signing_public_key: string
    exchange_public_key: string
    exchange_public_key_signature: string
    generation: number
  }
}

export interface DevicesResponse {
  user_id: string
  devices: DeviceIdentity[]
}

/**
 * List every device of a user that has published a DR identity. Used by the
 * per-device fan-out to address each linked device with its own ratchet.
 */
export function fetchDeviceIdentities(userId: string) {
  return getJson<DevicesResponse>(`/keys/devices/${userId}`)
}

export interface IdentityResponse {
  user_id: string
  device_id?: string
  identity: {
    signing_public_key: string
    exchange_public_key: string
    exchange_public_key_signature: string
    generation: number
  }
}

export function fetchIdentity(userId: string, deviceId?: string) {
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return getJson<IdentityResponse>(`/keys/identity/${userId}${qs}`)
}

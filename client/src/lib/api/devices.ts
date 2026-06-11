import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'
import { canonicalUserId } from '@/lib/user-id'

export type DeviceRow = {
  id: string
  device_name: string
  last_active: string
  user_agent: string | null
  ip_address: string | null
  revoked: boolean
  is_current: boolean
  is_master: boolean
}

export async function fetchDevices(): Promise<{
  current_device_id: string | null
  devices: DeviceRow[]
}> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/devices`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    current_device_id?: string | null
    devices?: DeviceRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'DEVICES_FETCH_FAILED')
  }
  return {
    current_device_id: data.current_device_id ?? null,
    devices: (data.devices ?? []).map((d) => ({
      ...d,
      id: canonicalUserId(d.id),
    })),
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  if (!deviceId) return

  const res = await fetchWithTimeout(
    `${API_URL}/users/me/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE', credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'DEVICE_REVOKE_FAILED')
  }
}

export async function setMasterDevice(deviceId: string): Promise<void> {
  if (!deviceId) return

  const res = await fetchWithTimeout(
    `${API_URL}/users/me/devices/${encodeURIComponent(deviceId)}/master`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_master: true }),
    }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    const fallback =
      res.status === 404
        ? 'DEVICE_NOT_FOUND'
        : res.status >= 500
        ? 'SERVER_ERROR'
        : res.status === 401
        ? 'UNAUTHORIZED'
        : 'SET_MASTER_FAILED'
    throw new Error(data.error ?? `${fallback} (${res.status})`)
  }
}

export async function revokeAllOtherSessions(): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/devices/revoke-all-others`, {
    method: 'POST',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'REVOKE_ALL_FAILED')
  }
}

export async function clearRevokedDevices(): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/devices/clear-revoked`, {
    method: 'POST',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'CLEAR_REVOKED_FAILED')
  }
}

export async function reauthorizeDevice(deviceId: string): Promise<void> {
  if (!deviceId) return

  const res = await fetchWithTimeout(
    `${API_URL}/users/me/devices/${encodeURIComponent(deviceId)}/reauthorize`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    const fallback =
      res.status === 404
        ? 'DEVICE_NOT_FOUND'
        : res.status >= 500
        ? 'SERVER_ERROR'
        : res.status === 401
        ? 'UNAUTHORIZED'
        : 'REAUTHORIZE_FAILED'
    throw new Error(data.error ?? `${fallback} (${res.status})`)
  }
}

// ─── Stage 4: Device Linking ─────────────────────────────────────────────────

export type LinkInitParams = {
  nonce: string
  signature: string
  totp_code?: string
}

export type LinkInitResult = {
  link_token: string
  expires_in: number
}

/**
 * Step 1 (old device): re-authenticate and obtain a one-time link_token.
 * The caller must sign `nonce` with the current device's ECDSA private key.
 */
export async function linkInit(params: LinkInitParams): Promise<LinkInitResult> {
  const res = await fetchWithTimeout(`${API_URL}/devices/link/init`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => ({}))) as LinkInitResult & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'LINK_INIT_FAILED')
  return { link_token: data.link_token, expires_in: data.expires_in }
}

export type LinkConfirmParams = {
  link_token: string
  /** Stable client device key from the NEW device (getOrCreateClientDeviceId()). */
  new_device_client_key: string
  /** New device's ECDSA P-256 public key JWK stringified. */
  new_device_pubkey: string
  /** Old device signature over SHA-256(new_device_client_key + "." + new_device_pubkey + "." + link_token), base64url. */
  signature: string
  device_name?: string
}

export type LinkConfirmResult = {
  ok: true
  user_id: string
}

/**
 * Step 2 (old device signs, new device calls this):
 * Sends the confirmation to the server; server verifies the old-device signature,
 * creates the new device row, and returns user_id so the new device can finalize auth.
 */
export async function linkConfirm(params: LinkConfirmParams): Promise<LinkConfirmResult> {
  const body: Record<string, string> = {
    link_token: params.link_token,
    new_device_client_key: params.new_device_client_key,
    new_device_pubkey: params.new_device_pubkey,
    signature: params.signature,
  }
  if (params.device_name) body.device_name = params.device_name
  // user_agent / ip_address are derived server-side from the request to
  // prevent forged audit-log entries.

  const res = await fetchWithTimeout(`${API_URL}/devices/link/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as LinkConfirmResult & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'LINK_CONFIRM_FAILED')
  return { ok: true, user_id: data.user_id }
}

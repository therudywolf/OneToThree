// Account recovery (Option A) — client API.
//
// All blobs here are opaque: the recovery vault blob is the keyring sealed
// under the client-only recovery phrase, and the auth pub JWK is the phrase-
// derived public key. The phrase itself never leaves the device.

import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'

export type RecoveryStatus = { enabled: boolean; require_totp: boolean }

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/recovery/status`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as Partial<RecoveryStatus> & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'RECOVERY_STATUS_FAILED')
  return { enabled: Boolean(data.enabled), require_totp: Boolean(data.require_totp) }
}

export async function enableRecovery(params: {
  recovery_vault_blob: string
  recovery_auth_pub_jwk: string
  require_totp: boolean
  totpCode?: string
}): Promise<{ require_totp: boolean }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const code = params.totpCode?.trim()
  if (code) headers['X-TOTP-Code'] = code
  const res = await fetchWithTimeout(`${API_URL}/users/me/recovery/enable`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      recovery_vault_blob: params.recovery_vault_blob,
      recovery_auth_pub_jwk: params.recovery_auth_pub_jwk,
      require_totp: params.require_totp,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; require_totp?: boolean; error?: string }
  if (!res.ok || !data.ok) throw new Error(data.error ?? 'RECOVERY_ENABLE_FAILED')
  return { require_totp: Boolean(data.require_totp) }
}

export async function disableRecovery(totpCode?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const code = totpCode?.trim()
  if (code) headers['X-TOTP-Code'] = code
  const res = await fetchWithTimeout(`${API_URL}/users/me/recovery/disable`, {
    method: 'POST',
    credentials: 'include',
    headers,
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || !data.ok) throw new Error(data.error ?? 'RECOVERY_DISABLE_FAILED')
}

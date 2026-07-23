import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from '@/lib/api/auth'

export type VaultFetchResponse = {
  encrypted_blob: string
  vault_version: number
  updated_at: string | null
}

export async function fetchVaultFromServer(): Promise<
  | { ok: true; data: VaultFetchResponse }
  | { ok: false; status: number; error?: string }
> {
  // Server-side vault sync was removed (Stage 6) — /api/vault/fetch no longer
  // exists. Short-circuit instead of firing a guaranteed 404 on every app boot:
  // the noise polluted logs and fed edge anti-bot heuristics (404-scan bans).
  return { ok: false, status: 410, error: 'VAULT_SYNC_REMOVED' }
}

export async function changeVaultPinOnServer(body: {
  encrypted_blob: string
}): Promise<
  | { ok: true; vault_version: number; updated_at: string }
  | { ok: false; error?: string }
> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/vault/change-pin`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    vault_version?: number
    updated_at?: string
    error?: string
  }
  if (!res.ok) {
    return { ok: false, error: data.error }
  }
  return {
    ok: true,
    vault_version: data.vault_version ?? 0,
    updated_at: data.updated_at ?? '',
  }
}

export async function syncVaultToServer(_body: {
  encrypted_blob: string
  expected_version?: number
}): Promise<
  | { ok: true; vault_version: number; updated_at: string }
  | { ok: false; status: number; error?: string; vault_version?: number }
> {
  // See fetchVaultFromServer — server-side vault sync no longer exists.
  return { ok: false, status: 410, error: 'VAULT_SYNC_REMOVED' }
}

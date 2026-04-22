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
  const res = await fetch(`${API_URL}/vault/fetch`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as VaultFetchResponse & {
    error?: string
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: data.error }
  }
  return { ok: true, data }
}

export async function changeVaultPinOnServer(body: {
  encrypted_blob: string
}): Promise<
  | { ok: true; vault_version: number; updated_at: string }
  | { ok: false; error?: string }
> {
  const res = await fetch(`${API_URL}/users/me/vault/change-pin`, {
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

export async function syncVaultToServer(body: {
  encrypted_blob: string
  expected_version?: number
}): Promise<
  | { ok: true; vault_version: number; updated_at: string }
  | { ok: false; status: number; error?: string; vault_version?: number }
> {
  const res = await fetch(`${API_URL}/vault/sync`, {
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
    return {
      ok: false,
      status: res.status,
      error: data.error,
      vault_version: data.vault_version,
    }
  }
  if (data.vault_version === undefined || !data.updated_at) {
    return { ok: false, status: 500, error: 'INVALID_SYNC_RESPONSE' }
  }
  return {
    ok: true,
    vault_version: data.vault_version,
    updated_at: data.updated_at,
  }
}

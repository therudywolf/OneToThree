import { fetchVaultFromServer, syncVaultToServer } from '@/lib/api/vault'
import { readVaultBlob } from '@/lib/vault'

const verKey = (userId: string) => `fm_vault_srv_ver:${userId}`

function readStoredVersion(userId: string): number | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(verKey(userId))
    if (v == null || v === '') return null
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeStoredVersion(userId: string, v: number): void {
  try {
    window.localStorage.setItem(verKey(userId), String(v))
  } catch {
    /* ignore */
  }
}

/**
 * Backs up the encrypted vault blob to the server after login (opaque ciphertext only).
 * Handles first upload and optimistic version alignment.
 */
export async function runPostLoginVaultSync(userId: string): Promise<void> {
  const blob = readVaultBlob(userId)
  if (!blob || typeof window === 'undefined') return

  const encrypted_blob = JSON.stringify(blob)

  const pull = await fetchVaultFromServer()
  let expected: number | undefined

  if (pull.ok) {
    expected = pull.data.vault_version
    const stored = readStoredVersion(userId)
    if (stored !== null && stored < pull.data.vault_version) {
      console.warn(
        '[vault] Server vault is newer than last synced version — open Settings if messages fail to decrypt.'
      )
    }
  } else if (pull.status === 404) {
    expected = 0
  } else {
    return
  }

  const up = await syncVaultToServer({ encrypted_blob, expected_version: expected })
  if (!up.ok) {
    if (up.status === 409) {
      console.warn('[vault] Sync conflict (409). Another device may have updated the backup.')
    }
    return
  }
  writeStoredVersion(userId, up.vault_version)
}

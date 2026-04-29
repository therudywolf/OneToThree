import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import { clearAllMediaCache } from '@/lib/media-cache'
import { purgeLocalMessageCache } from '@/lib/message-cache'
import { deleteWebAuthnMetaDb } from '@/lib/webauthn-vault'

/**
 * Aggressive local wipe (vault, caches, storage). Used when the server rejects the session as banned.
 */
export async function wipeAllClientLocalState(): Promise<void> {
  try {
    await clearAllMediaCache()
  } catch {
    /* ignore */
  }
  try {
    await purgeLocalMessageCache()
  } catch {
    /* ignore */
  }
  try {
    await deleteWebAuthnMetaDb()
  } catch {
    /* ignore */
  }
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear()
  } catch {
    /* ignore */
  }
}

/**
 * Nuclear wipe: optional server session revocation, all local IDBs + storage, then reload.
 */
export async function nuclearWipeClient(options?: {
  revokeServerSessions?: boolean
}): Promise<void> {
  if (options?.revokeServerSessions !== false) {
    try {
      await fetchWithTimeout(`${API_URL}/users/me/sessions`, {
        method: 'DELETE',
        credentials: 'include',
        keepalive: true,
      })
    } catch {
      /* ignore */
    }
  }
  await wipeAllClientLocalState()
  window.location.reload()
}

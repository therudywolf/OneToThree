import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import { clearAllMediaCache } from '@/lib/media-cache'
import { purgeLocalMessageCache } from '@/lib/message-cache'
import { deleteWebAuthnMetaDb } from '@/lib/webauthn-vault'
import { clearPrekeysForUser } from '@/lib/ratchet/prekey-store'
import { isNativeSecureStorageAvailable, secureStoreDelete } from '@/lib/native-keychain'

/**
 * Aggressive local wipe (vault, caches, storage). Used when the server rejects the session as banned.
 */
export async function wipeAllClientLocalState(): Promise<void> {
  // Snapshot user ids *before* clearing localStorage so we can scrub
  // their keychain slots afterwards.
  const userIds = collectVaultUserIds()

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
  // X3DH prekey private keys. These are RANDOM and stored locally now (they
  // used to be re-derivable from the vault), so a wipe that missed them would
  // leave live key material behind after the vault itself was gone.
  try {
    for (const id of userIds) await clearPrekeysForUser(id)
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
  try {
    await wipeServiceWorkerCaches()
  } catch {
    /* ignore */
  }
  try {
    await wipeKeychainSlots(userIds)
  } catch {
    /* ignore */
  }
}

/**
 * Snapshot every user id we have a persisted vault slot for. Must be called
 * BEFORE localStorage.clear() so the ids are still readable.
 */
function collectVaultUserIds(): string[] {
  const ids = new Set<string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      const m = k.match(/^p13:vault:stable:(.+)$/)
      if (m) ids.add(m[1])
    }
  } catch {
    /* localStorage may be locked down (Safari private mode) — best-effort */
  }
  return Array.from(ids)
}

/**
 * Drop the native-secure-storage-stashed vault PINs for the given user ids
 * (Tauri OS keychain OR Capacitor Android Keystore). Slot key is namespaced by
 * user id so other profiles on the same device are not affected. No-op on web.
 */
async function wipeKeychainSlots(userIds: readonly string[]): Promise<void> {
  if (!isNativeSecureStorageAvailable() || userIds.length === 0) return
  await Promise.all(userIds.map((id) => secureStoreDelete(`vault-pin:${id}`)))
}

/**
 * Drop every Cache Storage entry the service worker may have populated
 * (next-pwa runtime caches: p13-static, p13-readonly-api, p13-presigned-media).
 * Presigned media URLs live up to 7 days in cache by default — if we don't
 * scrub on logout/device-wipe an attacker with later access to the browser
 * can still pull last-week's attachments straight from the SW cache.
 *
 * No-op when Cache Storage isn't available (Safari private mode, Node SSR).
 */
async function wipeServiceWorkerCaches(): Promise<void> {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return
  const keys = await caches.keys()
  await Promise.all(
    keys.map((k) =>
      caches.delete(k).catch(() => {
        /* best-effort */
      })
    )
  )
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

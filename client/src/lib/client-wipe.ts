import { purgeLocalMessageCache } from '@/lib/message-cache'

/**
 * Aggressive local wipe (vault, caches, storage). Used when the server rejects the session as banned.
 */
export async function wipeAllClientLocalState(): Promise<void> {
  try {
    await purgeLocalMessageCache()
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

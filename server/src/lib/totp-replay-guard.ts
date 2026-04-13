/**
 * Prevents TOTP code replay within the same 30-second window.
 * Each (userId, code) pair is tracked and rejected if seen again before expiry.
 */

interface UsedEntry {
  expiresAt: number
}

/** Map key: `${userId}:${code}` */
const usedCodes = new Map<string, UsedEntry>()

/** TOTP window is 30s; keep entries for 60s to cover clock skew. */
const TTL_MS = 60_000
const CLEANUP_INTERVAL_MS = 60_000
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of usedCodes) {
      if (entry.expiresAt <= now) {
        usedCodes.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref()
  }
}

/**
 * Mark a TOTP code as used for a given user.
 * @returns `true` if the code was fresh (first use), `false` if it was already used (replay).
 */
export function consumeTotpCode(userId: string, code: string): boolean {
  const key = `${userId}:${code}`
  const existing = usedCodes.get(key)
  if (existing && existing.expiresAt > Date.now()) {
    return false // replay
  }
  usedCodes.set(key, { expiresAt: Date.now() + TTL_MS })
  startCleanup()
  return true
}

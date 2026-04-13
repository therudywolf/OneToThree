import { randomUUID } from 'node:crypto'

/**
 * In-memory JWT jti (JWT ID) denylist.
 * Tokens added here are rejected on every authenticated request until they expire.
 * Expired entries are periodically cleaned up to prevent unbounded growth.
 */

interface DenylistEntry {
  /** Absolute expiry timestamp in milliseconds. */
  expiresAt: number
}

const denylist = new Map<string, DenylistEntry>()

/** Cleanup interval: every 10 minutes. */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [jti, entry] of denylist) {
      if (entry.expiresAt <= now) {
        denylist.delete(jti)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  // Allow the process to exit without waiting for this timer.
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref()
  }
}

/** Generate a unique jti for a new token. */
export function generateJti(): string {
  return randomUUID()
}

/**
 * Deny a jti so that any token carrying it is rejected.
 * @param jti The JWT ID to deny.
 * @param expiresAt Absolute expiry time in seconds (Unix epoch) from the JWT `exp` claim.
 */
export function denyJti(jti: string, expiresAt: number): void {
  denylist.set(jti, { expiresAt: expiresAt * 1000 })
  startCleanup()
}

/** Check whether a jti has been denied (revoked). */
export function isJtiDenied(jti: string): boolean {
  const entry = denylist.get(jti)
  if (!entry) return false
  if (entry.expiresAt <= Date.now()) {
    denylist.delete(jti)
    return false
  }
  return true
}

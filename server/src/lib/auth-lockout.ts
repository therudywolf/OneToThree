/**
 * Per-username login lockout after consecutive ECDSA signature failures.
 *
 * Backs onto Redis when REDIS_URL is set, with in-process Map fallback for
 * single-node deployments and tests. Counts only `fail_signature` and
 * `fail_device_revoked` outcomes — successful verify resets the counter.
 *
 * Limits are intentionally permissive (5 fails per 15 minutes by default)
 * to avoid griefing attacks where someone locks a known username, but tight
 * enough to make targeted brute-force impractical.
 */

import { getRedis } from './redis.js'

const KEY_PREFIX = 'auth:fail:'
const DEFAULT_MAX_FAILS = 5
const DEFAULT_WINDOW_S = 15 * 60

function maxFails(): number {
  const raw = Number(process.env.AUTH_LOCKOUT_MAX_FAILS ?? DEFAULT_MAX_FAILS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FAILS
}

function windowSeconds(): number {
  const raw = Number(process.env.AUTH_LOCKOUT_WINDOW_S ?? DEFAULT_WINDOW_S)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WINDOW_S
}

type MemEntry = { count: number; expiresAt: number }
const mem = new Map<string, MemEntry>()

function pruneMem(now: number): void {
  for (const [k, v] of mem) if (v.expiresAt <= now) mem.delete(k)
}

function key(username: string): string {
  return `${KEY_PREFIX}${username.toLowerCase()}`
}

export type LockoutStatus = {
  locked: boolean
  retryAfterSeconds: number
  failuresSoFar: number
}

/** Check if `username` is currently locked. Does not increment. */
export async function checkLockout(username: string): Promise<LockoutStatus> {
  const max = maxFails()
  const r = getRedis()
  const k = key(username)

  if (r) {
    try {
      const [countStr, ttl] = await Promise.all([r.get(k), r.ttl(k)])
      const count = countStr ? Number(countStr) : 0
      const retryAfter = ttl > 0 ? ttl : 0
      return {
        locked: count >= max,
        retryAfterSeconds: count >= max ? retryAfter : 0,
        failuresSoFar: count,
      }
    } catch {
      /* Redis down — degrade to the in-memory map instead of 500-ing auth */
    }
  }

  const now = Date.now()
  pruneMem(now)
  const entry = mem.get(k)
  if (!entry) return { locked: false, retryAfterSeconds: 0, failuresSoFar: 0 }
  const retryAfter = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000))
  return {
    locked: entry.count >= max,
    retryAfterSeconds: entry.count >= max ? retryAfter : 0,
    failuresSoFar: entry.count,
  }
}

/**
 * Record a failed verify attempt. Returns the new failure count and lockout
 * status (so callers can return 429 with `Retry-After`).
 */
export async function recordFailure(username: string): Promise<LockoutStatus> {
  const max = maxFails()
  const window = windowSeconds()
  const r = getRedis()
  const k = key(username)

  if (r) {
    try {
      const count = await r.incr(k)
      if (count === 1) await r.expire(k, window)
      const ttl = count >= max ? await r.ttl(k) : 0
      return {
        locked: count >= max,
        retryAfterSeconds: count >= max && ttl > 0 ? ttl : 0,
        failuresSoFar: count,
      }
    } catch {
      /* Redis down — degrade to the in-memory map instead of 500-ing auth */
    }
  }

  const now = Date.now()
  pruneMem(now)
  const existing = mem.get(k)
  const next: MemEntry =
    existing && existing.expiresAt > now
      ? { count: existing.count + 1, expiresAt: existing.expiresAt }
      : { count: 1, expiresAt: now + window * 1000 }
  mem.set(k, next)
  return {
    locked: next.count >= max,
    retryAfterSeconds:
      next.count >= max ? Math.max(0, Math.ceil((next.expiresAt - now) / 1000)) : 0,
    failuresSoFar: next.count,
  }
}

/** Clear the failure counter for `username` (call on successful login). */
export async function resetLockout(username: string): Promise<void> {
  const r = getRedis()
  const k = key(username)
  if (r) {
    try {
      await r.del(k)
      return
    } catch {
      /* Redis down — clear the in-memory entry instead */
    }
  }
  mem.delete(k)
}

/** Test-only hook. */
export function _resetLockoutMemForTests(): void {
  mem.clear()
}

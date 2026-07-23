/**
 * Prevents TOTP code replay within the same 30-second window.
 *
 * Stage 2: backed by Redis when REDIS_URL is set.
 * Key schema: `totp:used:<userId>:<code>` EX 60
 *
 * Redis strategy: SET NX EX — atomic "set if not exists".
 * Returns false (replay) if key already exists, true if fresh.
 *
 * Fallback (no REDIS_URL): in-process Map, single-node only.
 */

import { getRedis } from './redis.js'

const KEY_PREFIX = 'totp:used:'
// verifyTotp accepts codes across a ±30s epoch tolerance, so a code is valid for
// roughly 90s. Keep the replay-guard entry for at least that full span (+skew)
// or a consumed code could be replayed in the gap after the guard entry expired
// but before the code itself stops verifying (#41).
const TTL_S = 120

interface UsedEntry { expiresAt: number }
const mem = new Map<string, UsedEntry>()

/**
 * Mark a TOTP code as used for a given user.
 * @returns `true` if the code was fresh (first use), `false` if it was already used (replay).
 */
export async function consumeTotpCode(userId: string, code: string): Promise<boolean> {
  const r = getRedis()
  if (r) {
    try {
      // SET NX EX — returns 'OK' on first use, null on replay
      const result = await r.set(`${KEY_PREFIX}${userId}:${code}`, '1', 'EX', TTL_S, 'NX')
      return result === 'OK'
    } catch {
      // Redis unavailable — fall through to in-memory fallback
    }
  }
  // in-memory fallback
  const key = `${userId}:${code}`
  const existing = mem.get(key)
  if (existing && existing.expiresAt > Date.now()) return false
  mem.set(key, { expiresAt: Date.now() + TTL_S * 1000 })
  return true
}

/**
 * Stage 3: Short-lived device-link tokens.
 *
 * link/init generates a cryptographically random token, stores it in Redis
 * (or in-memory fallback) with TTL 5 minutes.
 * link/confirm consumes (GETDEL) the token — one-time use.
 *
 * Key schema: `link_token:<token>`  — value is userId (string)
 */

import { getRedis } from './redis.js'

const KEY_PREFIX = 'link_token:'
const TTL_S = 300  // 5 minutes

interface MemEntry { userId: string; expiresAt: number }
const mem = new Map<string, MemEntry>()

export async function saveLinkToken(token: string, userId: string): Promise<void> {
  const r = getRedis()
  if (r) {
    try {
      await r.set(`${KEY_PREFIX}${token}`, userId, 'EX', TTL_S)
      return
    } catch {
      /* Redis down — fall through to the in-memory map */
    }
  }
  pruneMem()
  mem.set(token, { userId, expiresAt: Date.now() + TTL_S * 1000 })
}

/**
 * Atomically read-and-delete the token.
 * @returns userId if token was valid and fresh, null otherwise.
 */
export async function consumeLinkToken(token: string): Promise<string | null> {
  const r = getRedis()
  if (r) {
    try {
      const userId = await r.getdel(`${KEY_PREFIX}${token}`)
      return userId ?? null
    } catch {
      /* Redis down — fall through to the in-memory map */
    }
  }
  // in-memory fallback
  const entry = mem.get(token)
  mem.delete(token)
  if (!entry || entry.expiresAt < Date.now()) return null
  return entry.userId
}

function pruneMem(): void {
  const now = Date.now()
  for (const [k, v] of mem) {
    if (v.expiresAt < now) mem.delete(k)
  }
}

/** Test hook */
export function _resetLinkTokenStoreForTests(): void {
  mem.clear()
}

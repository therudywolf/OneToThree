import { randomUUID } from 'node:crypto'
import { getRedis } from './redis.js'

/**
 * JWT jti denylist.
 *
 * Stage 2: backed by Redis when REDIS_URL is set.
 * Key schema: `jti:denylist:<jti>` with TTL = remaining token lifetime.
 *
 * Fallback (no REDIS_URL): in-process Map, single-node only.
 * Cleanup interval removed — Redis TTL handles expiry; Map path prunes on read.
 */

interface DenylistEntry {
  expiresAt: number
}

const mem = new Map<string, DenylistEntry>()
const KEY_PREFIX = 'jti:denylist:'

/** Generate a unique jti for a new token. */
export function generateJti(): string {
  return randomUUID()
}

/**
 * Deny a jti so that any token carrying it is rejected.
 * @param jti   The JWT ID to deny.
 * @param expiresAt  Unix epoch seconds from the JWT `exp` claim.
 */
export async function denyJti(jti: string, expiresAt: number): Promise<void> {
  const r = getRedis()
  if (r) {
    const ttlSec = Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
    await r.set(`${KEY_PREFIX}${jti}`, '1', 'EX', ttlSec)
    return
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT denylist unavailable: Redis is required in production')
  }
  // dev/test in-memory fallback
  mem.set(jti, { expiresAt: expiresAt * 1000 })
}

/** Check whether a jti has been denied (revoked). */
export async function isJtiDenied(jti: string): Promise<boolean> {
  const r = getRedis()
  if (r) {
    const exists = await r.exists(`${KEY_PREFIX}${jti}`)
    return exists === 1
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT denylist unavailable: Redis is required in production')
  }
  // dev/test in-memory fallback
  const entry = mem.get(jti)
  if (!entry) return false
  if (entry.expiresAt <= Date.now()) {
    mem.delete(jti)
    return false
  }
  return true
}

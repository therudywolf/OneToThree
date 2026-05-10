/**
 * Auth challenge store (ECDSA nonce for login/register).
 *
 * Stage 2: backed by Redis when REDIS_URL is set.
 * Key schema: `challenge:<username>` EX 60
 *
 * Fallback (no REDIS_URL): in-process Map, single-node only.
 */

import { getRedis } from './redis.js'

export type PendingChallenge = {
  nonce: string
  expiresAt: number
}

const KEY_PREFIX = 'challenge:'
const TTL_S = 60

// in-memory fallback
const mem = new Map<string, PendingChallenge>()

export async function setChallenge(username: string, nonce: string): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.set(`${KEY_PREFIX}${username}`, nonce, 'EX', TTL_S)
    return
  }
  pruneMem()
  mem.set(username, { nonce, expiresAt: Date.now() + TTL_S * 1000 })
}

export async function getPending(username: string): Promise<PendingChallenge | null> {
  const r = getRedis()
  if (r) {
    const nonce = await r.get(`${KEY_PREFIX}${username}`)
    if (!nonce) return null
    // expiresAt not stored in Redis — TTL enforces it; we set a synthetic far-future value
    return { nonce, expiresAt: Date.now() + TTL_S * 1000 }
  }
  pruneMem()
  const row = mem.get(username)
  if (!row || Date.now() > row.expiresAt) {
    mem.delete(username)
    return null
  }
  return row
}

export async function deletePending(username: string): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.del(`${KEY_PREFIX}${username}`)
    return
  }
  mem.delete(username)
}

function pruneMem(): void {
  const now = Date.now()
  for (const [u, row] of mem) {
    if (now > row.expiresAt) mem.delete(u)
  }
}


import { randomUUID } from 'node:crypto'
import { getRedis } from './redis.js'

const TTL_MS = 10 * 60 * 1000
const TTL_S = Math.ceil(TTL_MS / 1000)
const KEY_PREFIX = 'avatar:nonce:'

const nonces = new Map<string, { userId: string; exp: number }>()

setInterval(() => {
  const now = Date.now()
  for (const [key, val] of nonces) {
    if (now > val.exp) nonces.delete(key)
  }
}, 10 * 60 * 1000).unref()

/** Issue a one-time nonce for signed avatar uploads. */
export async function issueAvatarNonce(userId: string): Promise<string> {
  const nonce = randomUUID()
  const r = getRedis()
  if (r) {
    await r.set(`${KEY_PREFIX}${nonce}`, userId, 'EX', TTL_S)
    return nonce
  }
  nonces.set(nonce, { userId, exp: Date.now() + TTL_MS })
  return nonce
}

/** True if nonce exists, belongs to user, and is not expired (does not consume). */
export async function validateAvatarNonce(
  userId: string,
  nonce: string
): Promise<boolean> {
  const n = nonce.trim()
  const r = getRedis()
  if (r) {
    const got = await r.get(`${KEY_PREFIX}${n}`)
    return got === userId
  }
  const row = nonces.get(n)
  return !!(row && row.userId === userId && Date.now() <= row.exp)
}

/** Validates nonce belongs to user and removes it (single use). */
export async function takeAvatarNonce(
  userId: string,
  nonce: string
): Promise<boolean> {
  const n = nonce.trim()
  const r = getRedis()
  if (r) {
    const key = `${KEY_PREFIX}${n}`
    const got = await r.get(key)
    if (got !== userId) {
      return false
    }
    await r.del(key)
    return true
  }
  const row = nonces.get(n)
  if (!row || row.userId !== userId || Date.now() > row.exp) {
    nonces.delete(n)
    return false
  }
  nonces.delete(n)
  return true
}

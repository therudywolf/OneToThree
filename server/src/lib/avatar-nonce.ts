import { randomUUID } from 'node:crypto'

const TTL_MS = 10 * 60 * 1000

const nonces = new Map<string, { userId: string; exp: number }>()

// Sweep expired nonces every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of nonces) {
    if (now > val.exp) nonces.delete(key)
  }
}, 10 * 60 * 1000).unref()

/** Issue a one-time nonce for signed avatar uploads. */
export function issueAvatarNonce(userId: string): string {
  const nonce = randomUUID()
  nonces.set(nonce, { userId, exp: Date.now() + TTL_MS })
  return nonce
}

/** True if nonce exists, belongs to user, and is not expired (does not consume). */
export function validateAvatarNonce(userId: string, nonce: string): boolean {
  const row = nonces.get(nonce.trim())
  return !!(row && row.userId === userId && Date.now() <= row.exp)
}

/** Validates nonce belongs to user and removes it (single use). */
export function takeAvatarNonce(userId: string, nonce: string): boolean {
  const row = nonces.get(nonce.trim())
  if (!row || row.userId !== userId || Date.now() > row.exp) {
    nonces.delete(nonce.trim())
    return false
  }
  nonces.delete(nonce.trim())
  return true
}

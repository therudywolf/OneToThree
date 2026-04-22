import { getRedis } from './redis.js'

export type QrLinkPayload = {
  sub: string
  username: string
  exp: number
}

const KEY_PREFIX = 'fm:qr:link:'
const mem = new Map<string, QrLinkPayload>()

/**
 * Persist a one-time QR link token. Uses Redis when `REDIS_URL` is set (multi-instance safe); otherwise in-memory Map.
 */
export async function saveQrLinkToken(
  token: string,
  payload: QrLinkPayload
): Promise<void> {
  const r = getRedis()
  const ttlMs = Math.max(1000, payload.exp - Date.now())
  const ttlSec = Math.ceil(ttlMs / 1000)
  if (r) {
    await r.set(
      `${KEY_PREFIX}${token}`,
      JSON.stringify(payload),
      'EX',
      ttlSec
    )
    return
  }
  mem.set(token, payload)
}

/** Atomically read and delete token if valid and not expired. */
export async function consumeQrLinkToken(
  token: string
): Promise<QrLinkPayload | null> {
  const r = getRedis()
  const key = `${KEY_PREFIX}${token}`
  if (r) {
    const raw = await r.getdel(key)
    if (!raw) return null
    try {
      const payload = JSON.parse(raw) as QrLinkPayload
      if (Date.now() > payload.exp) return null
      return payload
    } catch {
      return null
    }
  }
  const row = mem.get(token)
  mem.delete(token)
  if (!row || Date.now() > row.exp) return null
  return row
}

/** Test / shutdown hook */
export function _resetQrLinkStoreForTests(): void {
  mem.clear()
}

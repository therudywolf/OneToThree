import { Redis } from 'ioredis'

export type QrLinkPayload = {
  sub: string
  username: string
  exp: number
}

const KEY_PREFIX = 'fm:qr:link:'
const mem = new Map<string, QrLinkPayload>()

let redisClient: Redis | null | undefined

function redisUrl(): string | null {
  const u = process.env.REDIS_URL?.trim()
  return u || null
}

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient
  const url = redisUrl()
  if (!url) {
    redisClient = null
    return null
  }
  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    })
    redisClient.on('error', (err: Error) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          msg: '[qr-link-store] redis error',
          err: String(err),
        })}\n`
      )
    })
    return redisClient
  } catch {
    redisClient = null
    return null
  }
}

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
    const raw = await r.get(key)
    if (!raw) return null
    await r.del(key)
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
  if (redisClient) {
    try {
      void redisClient.quit()
    } catch {
      /* ignore */
    }
    redisClient = undefined
  }
}

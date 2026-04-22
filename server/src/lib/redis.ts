/**
 * Shared ioredis singleton for the API process.
 *
 * Stage 2: jwt-denylist, totp-replay-guard, challenge-store all use this
 * client instead of spinning up separate connections.
 *
 * If REDIS_URL is not set the module returns null and every caller
 * transparently falls back to in-process Map storage (single-node only).
 */

import { Redis } from 'ioredis'

let _client: Redis | null | undefined
let _warnedNoRedis = false

/** Lazy singleton. Returns null when REDIS_URL is not configured. */
export function getRedis(): Redis | null {
  if (_client !== undefined) return _client

  const url = process.env.REDIS_URL?.trim()
  if (!url) {
    if (!_warnedNoRedis) {
      _warnedNoRedis = true
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          msg: '[redis] REDIS_URL is not set; using in-memory fallbacks (single-process only)',
        })}\n`
      )
    }
    _client = null
    return null
  }

  try {
    _client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    })
    _client.on('error', (err: Error) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          msg: '[redis] client error',
          err: String(err),
        })}\n`
      )
    })
  } catch {
    _client = null
  }

  return _client
}

/** Graceful shutdown — call once on SIGTERM/SIGINT. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    try { await _client.quit() } catch { /* ignore */ }
    _client = undefined
  }
}

/** Test hook: reset singleton so next getRedis() re-reads REDIS_URL. */
export function _resetRedisForTests(): void {
  if (_client) {
    try { void _client.quit() } catch { /* ignore */ }
  }
  _client = undefined
  _warnedNoRedis = false
}

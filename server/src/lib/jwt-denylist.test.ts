import { describe, expect, it, vi, beforeEach } from 'vitest'
import { _resetRedisForTests } from './redis.js'

describe('jwt-denylist in-memory fallback', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL
    _resetRedisForTests()
    vi.resetModules()
  })

  it('denies jti until it expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { denyJti, isJtiDenied } = await import('./jwt-denylist.js')
    const nowSec = Math.floor(Date.now() / 1000)
    await denyJti('jti-1', nowSec + 5)
    await expect(isJtiDenied('jti-1')).resolves.toBe(true)
    vi.advanceTimersByTime(6_000)
    await expect(isJtiDenied('jti-1')).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('returns false for unknown jti', async () => {
    const { isJtiDenied } = await import('./jwt-denylist.js')
    await expect(isJtiDenied('missing')).resolves.toBe(false)
  })
})

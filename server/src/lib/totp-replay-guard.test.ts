import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetRedisForTests } from './redis.js'

describe('consumeTotpCode fallback behavior', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL
    _resetRedisForTests()
    vi.resetModules()
  })

  it('allows first use and rejects replay in active window', async () => {
    const { consumeTotpCode } = await import('./totp-replay-guard.js')
    await expect(consumeTotpCode('u-1', '123456')).resolves.toBe(true)
    await expect(consumeTotpCode('u-1', '123456')).resolves.toBe(false)
  })

  it('allows same code after TTL expiration window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { consumeTotpCode } = await import('./totp-replay-guard.js')
    await expect(consumeTotpCode('u-2', '654321')).resolves.toBe(true)
    vi.advanceTimersByTime(61_000)
    await expect(consumeTotpCode('u-2', '654321')).resolves.toBe(true)
    vi.useRealTimers()
  })
})

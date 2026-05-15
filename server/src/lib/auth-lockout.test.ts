import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkLockout,
  recordFailure,
  resetLockout,
  _resetLockoutMemForTests,
} from './auth-lockout.js'

describe('auth-lockout (in-memory fallback)', () => {
  beforeEach(() => {
    _resetLockoutMemForTests()
    process.env.AUTH_LOCKOUT_MAX_FAILS = '3'
    process.env.AUTH_LOCKOUT_WINDOW_S = '60'
    delete process.env.REDIS_URL
  })

  afterEach(() => {
    delete process.env.AUTH_LOCKOUT_MAX_FAILS
    delete process.env.AUTH_LOCKOUT_WINDOW_S
  })

  it('is unlocked initially', async () => {
    const s = await checkLockout('alice')
    expect(s.locked).toBe(false)
    expect(s.failuresSoFar).toBe(0)
  })

  it('locks after configured failure count', async () => {
    await recordFailure('alice')
    expect((await checkLockout('alice')).locked).toBe(false)
    await recordFailure('alice')
    await recordFailure('alice')
    const s = await checkLockout('alice')
    expect(s.locked).toBe(true)
    expect(s.retryAfterSeconds).toBeGreaterThan(0)
    expect(s.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('reset clears lockout', async () => {
    await recordFailure('alice')
    await recordFailure('alice')
    await recordFailure('alice')
    expect((await checkLockout('alice')).locked).toBe(true)
    await resetLockout('alice')
    expect((await checkLockout('alice')).locked).toBe(false)
  })

  it('lockout is per-username', async () => {
    await recordFailure('alice')
    await recordFailure('alice')
    await recordFailure('alice')
    expect((await checkLockout('alice')).locked).toBe(true)
    expect((await checkLockout('bob')).locked).toBe(false)
  })

  it('username comparison is case-insensitive', async () => {
    await recordFailure('Alice')
    await recordFailure('ALICE')
    await recordFailure('alice')
    expect((await checkLockout('alice')).locked).toBe(true)
    expect((await checkLockout('ALICE')).locked).toBe(true)
  })
})

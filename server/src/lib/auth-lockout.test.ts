import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeRedis = {
  store: Map<string, { count: number; ttl: number }>
  get(k: string): Promise<string | null>
  ttl(k: string): Promise<number>
  expire(k: string, s: number): Promise<number>
  del(k: string): Promise<number>
  eval(script: string, numKeys: number, k: string, arg: string): Promise<[number, number]>
}

const { redisRef } = vi.hoisted(() => ({
  redisRef: { current: null as FakeRedis | null },
}))
vi.mock('./redis.js', () => ({ getRedis: () => redisRef.current }))

import {
  checkLockout,
  recordFailure,
  resetLockout,
  _resetLockoutMemForTests,
} from './auth-lockout.js'

/** Minimal INCR/TTL/EXPIRE fake — enough to exercise the atomic-increment path. */
function makeFakeRedis(): FakeRedis {
  const store = new Map<string, { count: number; ttl: number }>()
  return {
    store,
    async get(k) {
      const e = store.get(k)
      return e ? String(e.count) : null
    },
    async ttl(k) {
      const e = store.get(k)
      return e ? e.ttl : -2
    },
    async expire(k, s) {
      const e = store.get(k)
      if (!e) return 0
      e.ttl = s
      return 1
    },
    async del(k) {
      return store.delete(k) ? 1 : 0
    },
    // Mirrors INCR_WITH_TTL_LUA: increment, then arm the TTL when there is none.
    async eval(_script, _numKeys, k, arg) {
      const e = store.get(k) ?? { count: 0, ttl: -1 }
      e.count += 1
      if (e.ttl < 0) e.ttl = Number(arg)
      store.set(k, e)
      return [e.count, e.ttl]
    },
  }
}

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

describe('auth-lockout (Redis path)', () => {
  let redis: FakeRedis

  beforeEach(() => {
    _resetLockoutMemForTests()
    process.env.AUTH_LOCKOUT_MAX_FAILS = '3'
    process.env.AUTH_LOCKOUT_WINDOW_S = '60'
    redis = makeFakeRedis()
    redisRef.current = redis
  })

  afterEach(() => {
    redisRef.current = null
    delete process.env.AUTH_LOCKOUT_MAX_FAILS
    delete process.env.AUTH_LOCKOUT_WINDOW_S
  })

  it('arms the TTL on the very first failure', async () => {
    const s = await recordFailure('alice')
    expect(s.failuresSoFar).toBe(1)
    expect(redis.store.get('auth:fail:alice')?.ttl).toBe(60)
  })

  it('self-heals a counter that lost its TTL instead of locking forever', async () => {
    // Exactly the state a dropped connection between INCR and EXPIRE leaves
    // behind: count at the limit with TTL -1. checkLockout used to report
    // retryAfterSeconds: 0 forever and no code path could ever clear it.
    redis.store.set('auth:fail:alice', { count: 3, ttl: -1 })

    const s = await checkLockout('alice')
    expect(s.locked).toBe(true)
    expect(s.retryAfterSeconds).toBe(60)
    expect(redis.store.get('auth:fail:alice')?.ttl).toBe(60)
  })

  it('re-arms the TTL on the next failure when it was lost', async () => {
    redis.store.set('auth:fail:alice', { count: 1, ttl: -1 })
    const s = await recordFailure('alice')
    expect(s.failuresSoFar).toBe(2)
    expect(redis.store.get('auth:fail:alice')?.ttl).toBe(60)
  })

  it('reset clears the Redis counter', async () => {
    await recordFailure('alice')
    await resetLockout('alice')
    expect(redis.store.has('auth:fail:alice')).toBe(false)
  })
})

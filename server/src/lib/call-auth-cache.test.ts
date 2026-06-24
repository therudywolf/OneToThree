import { afterEach, describe, expect, it } from 'vitest'
import {
  __clearCallAuthCacheForTest,
  getCachedCallAuth,
  invalidateCallAuth,
  setCachedCallAuth,
} from './call-auth-cache.js'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

describe('call-auth-cache', () => {
  afterEach(() => {
    __clearCallAuthCacheForTest()
  })

  it('returns undefined for an unseen pair (caller must hit the DB)', () => {
    expect(getCachedCallAuth(A, B)).toBeUndefined()
  })

  it('caches and returns an authorized decision within the TTL', () => {
    const now = 1_000_000
    setCachedCallAuth(A, B, true, 30_000, now)
    expect(getCachedCallAuth(A, B, now + 1)).toBe(true)
    expect(getCachedCallAuth(A, B, now + 29_999)).toBe(true)
  })

  it('caches and returns a denied decision within the TTL', () => {
    const now = 1_000_000
    setCachedCallAuth(A, B, false, 30_000, now)
    expect(getCachedCallAuth(A, B, now + 1)).toBe(false)
  })

  it('expires the entry once the TTL lapses (forces a DB re-check)', () => {
    const now = 1_000_000
    setCachedCallAuth(A, B, true, 30_000, now)
    expect(getCachedCallAuth(A, B, now + 30_000)).toBeUndefined()
    expect(getCachedCallAuth(A, B, now + 30_001)).toBeUndefined()
  })

  it('is directional — caching A->B does not authorize B->A', () => {
    setCachedCallAuth(A, B, true)
    expect(getCachedCallAuth(B, A)).toBeUndefined()
  })

  it('invalidateCallAuth evicts both directions immediately (block/unblock)', () => {
    setCachedCallAuth(A, B, true)
    setCachedCallAuth(B, A, true)
    invalidateCallAuth(A, B)
    expect(getCachedCallAuth(A, B)).toBeUndefined()
    expect(getCachedCallAuth(B, A)).toBeUndefined()
  })
})

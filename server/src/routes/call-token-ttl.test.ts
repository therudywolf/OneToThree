import { afterEach, describe, expect, it } from 'vitest'
import { resolveCallTokenTtlSeconds } from './call.js'

const ENV = 'LIVEKIT_TOKEN_TTL_SECONDS'

describe('resolveCallTokenTtlSeconds (D20)', () => {
  afterEach(() => {
    delete process.env[ENV]
  })

  it('defaults to 2h when unset', () => {
    delete process.env[ENV]
    expect(resolveCallTokenTtlSeconds()).toBe(60 * 60 * 2)
  })

  it('defaults to 2h when non-numeric', () => {
    process.env[ENV] = 'not-a-number'
    expect(resolveCallTokenTtlSeconds()).toBe(60 * 60 * 2)
  })

  it('honors an in-range operator override', () => {
    process.env[ENV] = String(60 * 60 * 3)
    expect(resolveCallTokenTtlSeconds()).toBe(60 * 60 * 3)
  })

  it('clamps an over-long override to the 4h ceiling (no 6h+ stale-key window)', () => {
    process.env[ENV] = String(60 * 60 * 6)
    expect(resolveCallTokenTtlSeconds()).toBe(60 * 60 * 4)
  })

  it('clamps an absurdly small override up to the 5min floor', () => {
    process.env[ENV] = '10'
    expect(resolveCallTokenTtlSeconds()).toBe(60 * 5)
  })
})

import { describe, it, expect } from 'vitest'
import { ALL_ON, mergeCapabilities, type Capabilities } from '@/lib/api/capabilities'

describe('mergeCapabilities (fail-open capability gating)', () => {
  it('defaults everything ON for an empty/garbage payload', () => {
    for (const raw of [null, undefined, {}, { features: null }, 'nope', 42, [], { features: 'x' }]) {
      expect(mergeCapabilities(raw)).toEqual(ALL_ON)
    }
  })

  it('disables ONLY features the server explicitly reports false', () => {
    const caps = mergeCapabilities({ features: { calls: false, push: false } })
    expect(caps.calls).toBe(false)
    expect(caps.push).toBe(false)
    // Everything else stays on.
    expect(caps.media).toBe(true)
    expect(caps.stickers).toBe(true)
    expect(caps.gif).toBe(true)
    expect(caps.twofa).toBe(true)
    expect(caps.admin).toBe(true)
    expect(caps.groups).toBe(true)
  })

  it('treats truthy-but-not-true and missing values as ON (fail open)', () => {
    // Only a strict `false` gates a feature off; anything else is left enabled.
    const caps = mergeCapabilities({ features: { calls: 0, media: 'yes', gif: null, push: undefined } })
    expect(caps.calls).toBe(true)
    expect(caps.media).toBe(true)
    expect(caps.gif).toBe(true)
    expect(caps.push).toBe(true)
  })

  it('ignores unknown keys and never mutates ALL_ON', () => {
    const before = JSON.stringify(ALL_ON)
    const caps: Capabilities = mergeCapabilities({ features: { calls: false, bogus: false } })
    expect(caps.calls).toBe(false)
    expect(caps).not.toHaveProperty('bogus')
    expect(JSON.stringify(ALL_ON)).toBe(before) // ALL_ON untouched
  })
})

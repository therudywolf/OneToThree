import { describe, expect, it } from 'vitest'
import {
  FETCH_HEADER_UTF8_PREFIX,
  isIso88591HeaderSafe,
  toFetchSafeHeaderValue,
} from './http-fetch-headers'

describe('http-fetch-headers', () => {
  it('detects non-Latin-1', () => {
    expect(isIso88591HeaderSafe('ascii')).toBe(true)
    expect(isIso88591HeaderSafe('café')).toBe(true) // é is U+00E9
    expect(isIso88591HeaderSafe('русский')).toBe(false)
  })

  it('round-trips via encodeURIComponent shape', () => {
    const label = 'Win · русский'
    const h = toFetchSafeHeaderValue(label, 64)
    expect(h.startsWith(FETCH_HEADER_UTF8_PREFIX)).toBe(true)
    expect(decodeURIComponent(h.slice(FETCH_HEADER_UTF8_PREFIX.length))).toBe(
      label
    )
  })
})

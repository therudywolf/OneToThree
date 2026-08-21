import { describe, expect, it } from 'vitest'
import { formatExpiry } from './guest-links-modal'

/**
 * The TTL shown on each guest link.
 *
 * Two things this has to get right, both user-visible on every row:
 *
 *  - **The units come from the dictionary.** They were hardcoded Russian in an
 *    otherwise fully translated modal, so an English reader — now the common
 *    case, since guests follow their browser's language — saw "40 мин" in the
 *    middle of an English screen.
 *  - **A link with seconds left is not "0".** Rounding sub-minute to `0 мин`
 *    made a live link indistinguishable at a glance from a dead one, which is
 *    the single distinction this column exists to draw.
 */

const L = { expired: 'expired', minutes: 'min', hours: 'h', days: 'd' }
const NOW = Date.parse('2026-08-20T12:00:00.000Z')
const inMs = (ms: number) => new Date(NOW + ms).toISOString()

describe('guest link expiry', () => {
  it('uses the labels it is given, never a baked-in language', () => {
    expect(formatExpiry(inMs(40 * 60_000), L, NOW)).toBe('40 min')
    expect(formatExpiry(inMs(3 * 3_600_000), L, NOW)).toBe('3 h')
    expect(formatExpiry(inMs(4 * 86_400_000), L, NOW)).toBe('4 d')
    const ru = { expired: 'истекла', minutes: 'мин', hours: 'ч', days: 'д' }
    expect(formatExpiry(inMs(40 * 60_000), ru, NOW)).toBe('40 мин')
  })

  it('a link with seconds left reads as alive, not as 0', () => {
    expect(formatExpiry(inMs(20_000), L, NOW)).toBe('<1 min')
  })

  it('an elapsed or exactly-due link is expired', () => {
    expect(formatExpiry(inMs(0), L, NOW)).toBe('expired')
    expect(formatExpiry(inMs(-60_000), L, NOW)).toBe('expired')
  })

  it('an unparseable timestamp is expired rather than NaN', () => {
    expect(formatExpiry('not a date', L, NOW)).toBe('expired')
  })

  it('switches units at the documented boundaries', () => {
    // 59 minutes stays minutes; 60 becomes an hour.
    expect(formatExpiry(inMs(59 * 60_000), L, NOW)).toBe('59 min')
    expect(formatExpiry(inMs(60 * 60_000), L, NOW)).toBe('1 h')
    // 47 hours stays hours; 48 becomes days.
    expect(formatExpiry(inMs(47 * 3_600_000), L, NOW)).toBe('47 h')
    expect(formatExpiry(inMs(48 * 3_600_000), L, NOW)).toBe('2 d')
  })
})

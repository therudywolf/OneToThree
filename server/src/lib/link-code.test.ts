import { describe, expect, it } from 'vitest'
import {
  LINK_CODE_LENGTH,
  formatLinkCode,
  generateLinkCode,
  hashLinkCode,
  isValidLinkCode,
  linkCodeMatches,
  normalizeLinkCode,
} from './link-code.js'

/**
 * The code exists to be read off one screen and typed into another, quite
 * possibly over the phone. So the properties that matter are not cryptographic
 * — they are typographic:
 *
 *  - every way a person can mistype it lands on the same value, or on nothing;
 *  - it cannot contain the characters people mistype in the first place;
 *  - and the hyphen we add for legibility is not part of the code.
 */

describe('normalisation', () => {
  it('folds case, spaces and the display hyphen', () => {
    expect(normalizeLinkCode(' a7k2-9qf3 ')).toBe('A7K29QF3')
    expect(normalizeLinkCode('A7K2 9QF3')).toBe('A7K29QF3')
  })

  it('folds every character the alphabet excludes onto the one it looks like', () => {
    // O/0 and I/l/1 are the pairs that actually get confused when read aloud
    // or copied by hand.
    expect(normalizeLinkCode('OIL')).toBe('011')
    expect(normalizeLinkCode('oil')).toBe('011')
    expect(normalizeLinkCode('U')).toBe('V')
  })

  it('folds the other dashes a keyboard or a chat app might produce', () => {
    for (const dash of ['-', '‐', '‒', '–', '—', '―']) {
      expect(normalizeLinkCode(`A7K2${dash}9QF3`), dash).toBe('A7K29QF3')
    }
  })
})

describe('validation', () => {
  it('accepts what generateLinkCode produces, every time', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLinkCode()
      expect(code).toHaveLength(LINK_CODE_LENGTH)
      expect(isValidLinkCode(code)).toBe(true)
      // Round-trips through the display form a person actually reads.
      expect(normalizeLinkCode(formatLinkCode(code))).toBe(code)
    }
  })

  it('never emits a character that normalisation would change', () => {
    // A generated `O` would normalise to `0` and stop matching its own hash.
    for (let i = 0; i < 200; i++) {
      const code = generateLinkCode()
      expect(normalizeLinkCode(code)).toBe(code)
    }
  })

  it('rejects the wrong length and characters off the alphabet', () => {
    expect(isValidLinkCode('A7K29QF')).toBe(false)
    expect(isValidLinkCode('A7K29QF33')).toBe(false)
    expect(isValidLinkCode('A7K29QF!')).toBe(false)
    expect(isValidLinkCode('')).toBe(false)
  })
})

describe('display', () => {
  it('splits into two halves', () => {
    expect(formatLinkCode('A7K29QF3')).toBe('A7K2-9QF3')
  })
})

describe('matching', () => {
  it('matches a code typed in any of the ways a person types it', () => {
    const code = 'A7K29QF3'
    const hash = hashLinkCode(code)
    for (const typed of ['A7K29QF3', 'a7k29qf3', 'A7K2-9QF3', ' a7k2 9qf3 ']) {
      expect(linkCodeMatches(typed, hash), typed).toBe(true)
    }
  })

  it('does not match anything else', () => {
    const hash = hashLinkCode('A7K29QF3')
    expect(linkCodeMatches('A7K29QF4', hash)).toBe(false)
    expect(linkCodeMatches('', hash)).toBe(false)
    expect(linkCodeMatches('A7K29QF3', null)).toBe(false)
    expect(linkCodeMatches('nonsense', hash)).toBe(false)
  })

  it('hashes are domain-separated, not bare SHA-256 of the code', async () => {
    // Without the label, a rainbow table over 2^40 eight-character codes is a
    // one-off cost that any leak of the store would immediately cash in.
    const { createHash } = await import('node:crypto')
    const bare = createHash('sha256').update('A7K29QF3').digest('hex')
    expect(hashLinkCode('A7K29QF3')).not.toBe(bare)
  })

  it('generates distinct codes', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(generateLinkCode())
    // 500 draws from 2^40 colliding at all would be extraordinary.
    expect(seen.size).toBe(500)
  })
})

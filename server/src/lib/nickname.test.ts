import { describe, expect, it } from 'vitest'
import { parseNickname } from './nickname.js'

describe('parseNickname', () => {
  it('canonicalises to lower case and keeps the typed casing for display', () => {
    const r = parseNickname('RudyWolf')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe('rudywolf')
    expect(r.display).toBe('RudyWolf')
  })

  it('maps every case variant of a handle onto one canonical value', () => {
    // The impersonation bug: users.username is a case-sensitive UNIQUE column,
    // so `RudyWolf` used to register as a second account next to `rudywolf`.
    const variants = ['rudywolf', 'RUDYWOLF', 'RudyWolf', '  RudyWOLF  ']
    const canonical = variants.map((v) => {
      const r = parseNickname(v)
      return r.ok ? r.value : null
    })
    expect(new Set(canonical)).toEqual(new Set(['rudywolf']))
  })

  it('rejects reserved handles regardless of casing', () => {
    for (const raw of ['admin', 'Admin', 'ROOT']) {
      const r = parseNickname(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('USERNAME_RESERVED')
    }
  })

  it('rejects malformed handles', () => {
    for (const raw of ['ab', 'has space', 'nope!', 'x'.repeat(33)]) {
      const r = parseNickname(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('INVALID_USERNAME_FORMAT')
    }
  })
})

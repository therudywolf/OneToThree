import { describe, expect, it } from 'vitest'
import { isUuid, normalizePeerInput } from '@/lib/peer-input'

describe('peer-input normalize', () => {
  it('sanitizes poisoned values to empty string', () => {
    expect(normalizePeerInput('undefined')).toBe('')
    expect(normalizePeerInput(' null ')).toBe('')
  })

  it('keeps plain username input', () => {
    expect(normalizePeerInput('rudywolf')).toBe('rudywolf')
  })

  it('normalizes uuid values', () => {
    const uuid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    expect(isUuid(uuid)).toBe(true)
    expect(normalizePeerInput(uuid)).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('extracts invite uuid from URL', () => {
    const out = normalizePeerInput('https://onetothree.ru/?invite=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(out).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })
})


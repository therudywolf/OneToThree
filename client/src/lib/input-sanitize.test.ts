import { describe, expect, it } from 'vitest'
import { sanitizeTextInput } from '@/lib/input-sanitize'

describe('sanitizeTextInput', () => {
  it('returns empty string for non-string values', () => {
    expect(sanitizeTextInput(undefined)).toBe('')
    expect(sanitizeTextInput(null)).toBe('')
    expect(sanitizeTextInput(42)).toBe('')
    expect(sanitizeTextInput({ value: 'x' })).toBe('')
  })

  it('normalizes poisoned string values to empty', () => {
    expect(sanitizeTextInput('undefined')).toBe('')
    expect(sanitizeTextInput(' null ')).toBe('')
    expect(sanitizeTextInput('UNDEFINED')).toBe('')
  })

  it('keeps regular user input unchanged', () => {
    expect(sanitizeTextInput('hello')).toBe('hello')
    expect(sanitizeTextInput('  hello')).toBe('  hello')
    expect(sanitizeTextInput('rudywolf')).toBe('rudywolf')
  })
})


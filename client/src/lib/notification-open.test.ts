import { describe, expect, it } from 'vitest'
import { parseTargetChatIdFromUrl } from './notification-open'

describe('notification-open', () => {
  it('extracts chat id from relative URL', () => {
    expect(parseTargetChatIdFromUrl('/?chat=abc')).toBe('abc')
  })

  it('extracts chat id from absolute URL with extra params', () => {
    expect(
      parseTargetChatIdFromUrl('https://app.example.test/?chat=abc-123&accept_call=1')
    ).toBe('abc-123')
  })

  it('returns null for missing or invalid url', () => {
    expect(parseTargetChatIdFromUrl('/')).toBeNull()
    expect(parseTargetChatIdFromUrl(':::::')).toBeNull()
  })
})


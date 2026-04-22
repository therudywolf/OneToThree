import { describe, expect, it } from 'vitest'
import { decodeFetchUtf8Header } from './http-fetch-headers.js'

describe('decodeFetchUtf8Header', () => {
  it('passes through plain ASCII', () => {
    expect(decodeFetchUtf8Header('  MacIntel | Mozilla/5.0  ', 512)).toBe(
      'MacIntel | Mozilla/5.0'
    )
  })

  it('decodes FM1 percent-encoded UTF-8', () => {
    const encoded = `FM1:${encodeURIComponent('русский · device')}`
    expect(decodeFetchUtf8Header(encoded, 512)).toBe('русский · device')
  })

  it('respects max length after decode', () => {
    const encoded = `FM1:${encodeURIComponent('abcdefghij')}`
    expect(decodeFetchUtf8Header(encoded, 4)).toBe('abcd')
  })

  it('returns empty for undefined', () => {
    expect(decodeFetchUtf8Header(undefined, 10)).toBe('')
  })
})

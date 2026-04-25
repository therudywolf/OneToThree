import { describe, expect, it } from 'vitest'
import { normalizeApiRoot, normalizeHttpOrigin } from './url'

describe('api url normalization', () => {
  it('normalizes API roots without duplicating /api', () => {
    expect(normalizeApiRoot('https://api.onetothree.ru')).toBe('https://api.onetothree.ru/api')
    expect(normalizeApiRoot('https://api.onetothree.ru/api')).toBe('https://api.onetothree.ru/api')
    expect(normalizeApiRoot('/api')).toBe('/api')
    expect(normalizeApiRoot('', { sameOriginFallback: 'https://onetothree.ru/api' })).toBe(
      'https://onetothree.ru/api'
    )
  })

  it('normalizes origins for websocket and native-cookie code paths', () => {
    expect(normalizeHttpOrigin('https://api.onetothree.ru/api')).toBe('https://api.onetothree.ru')
    expect(normalizeHttpOrigin('same-origin')).toBeNull()
    expect(normalizeHttpOrigin('capacitor://localhost')).toBeNull()
  })
})

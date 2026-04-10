import { describe, expect, it } from 'vitest'
import { generateSafetyNumber } from '@/lib/crypto'

/** Fixed P-256 public JWK — golden fingerprint computed via Web Crypto SHA-256 + decimal projection. */
const STATIC_P256_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
}

describe('generateSafetyNumber', () => {
  it('returns 6 blocks of 5 digits (30 digits total) deterministically', async () => {
    const a = await generateSafetyNumber(STATIC_P256_JWK)
    const b = await generateSafetyNumber(STATIC_P256_JWK)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/)
    expect(a.replace(/\s/g, '').length).toBe(30)
  })

  it('matches golden fingerprint for canonical sorted JWK JSON', async () => {
    const n = await generateSafetyNumber(STATIC_P256_JWK)
    expect(n).toBe('51788 99978 45460 91471 42841 45456')
  })
})

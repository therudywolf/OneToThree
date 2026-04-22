import { describe, expect, it } from 'vitest'
import { extractVaultPayload } from '@/lib/vault-signing'

describe('extractVaultPayload', () => {
  it('parses V2 payload with both keys', () => {
    const raw = JSON.stringify({
      v: 2,
      ecdsaPrivateJwk: '{"kty":"EC","crv":"P-256"}',
      ecdhPrivateJwk: '{"kty":"EC","crv":"P-256"}',
    })
    const parsed = extractVaultPayload(raw)
    expect(parsed?.kind).toBe('V2')
  })

  it('parses legacy EC JWK payload', () => {
    const parsed = extractVaultPayload('{"kty":"EC","crv":"P-256","d":"abc"}')
    expect(parsed?.kind).toBe('LEGACY')
  })

  it('returns null for invalid payload', () => {
    expect(extractVaultPayload('')).toBeNull()
    expect(extractVaultPayload('{"v":2}')).toBeNull()
    expect(extractVaultPayload('not-json')).toBeNull()
  })
})

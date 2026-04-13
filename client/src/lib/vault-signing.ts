/**
 * PROJECT 13 :: VAULT_PAYLOAD_EXTRACTOR
 * Level: Core Layer (Secret Encapsulation)
 */

export type ExtractedVault =
  | { kind: 'V2'; ecdsaJwk: string; ecdhJwk: string }
  | { kind: 'LEGACY'; ecdhJwk: string }

export function extractVaultPayload(raw: string): ExtractedVault | null {
  const signal = raw.trim()
  if (!signal) return null

  try {
    const data = JSON.parse(signal)
    if (!data || typeof data !== 'object') return null

    if (data.v === 2 && data.ecdsaPrivateJwk && data.ecdhPrivateJwk) {
      return {
        kind: 'V2',
        ecdsaJwk: data.ecdsaPrivateJwk,
        ecdhJwk: data.ecdhPrivateJwk,
      }
    }

    if (data.kty === 'EC' && data.d && data.crv) {
      return { kind: 'LEGACY', ecdhJwk: signal }
    }
  } catch {
    return null
  }
  return null
}
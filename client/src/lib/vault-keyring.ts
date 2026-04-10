/**
 * Plaintext inside the PIN-wrapped vault blob.
 * v2: ECDSA (auth) + ECDH (E2E). Legacy: single ECDH JWK JSON string.
 */

export type VaultKeyringV2 = {
  v: 2
  ecdsaPrivateJwk: string
  ecdhPrivateJwk: string
}

export type ParsedVaultPlaintext =
  | { kind: 'v2'; ecdsaPrivateJwk: string; ecdhPrivateJwk: string }
  | { kind: 'legacy_ecdh'; ecdhPrivateJwkString: string }

export function stringifyVaultKeyringV2(
  ecdsaPrivateJwk: string,
  ecdhPrivateJwk: string
): string {
  const payload: VaultKeyringV2 = {
    v: 2,
    ecdsaPrivateJwk,
    ecdhPrivateJwk,
  }
  return JSON.stringify(payload)
}

export function parseVaultPlaintext(plain: string): ParsedVaultPlaintext | null {
  const trimmed = plain.trim()
  if (!trimmed) return null
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>
    if (
      o &&
      typeof o === 'object' &&
      o.v === 2 &&
      typeof o.ecdsaPrivateJwk === 'string' &&
      typeof o.ecdhPrivateJwk === 'string'
    ) {
      return {
        kind: 'v2',
        ecdsaPrivateJwk: o.ecdsaPrivateJwk,
        ecdhPrivateJwk: o.ecdhPrivateJwk,
      }
    }
    if (
      o &&
      typeof o === 'object' &&
      o.kty === 'EC' &&
      typeof o.d === 'string' &&
      typeof o.crv === 'string'
    ) {
      return { kind: 'legacy_ecdh', ecdhPrivateJwkString: trimmed }
    }
  } catch {
    return null
  }
  return null
}

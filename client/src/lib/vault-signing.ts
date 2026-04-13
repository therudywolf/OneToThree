/**
 * PROJECT 13 :: VAULT_PAYLOAD_EXTRACTOR
 * Level: Core Layer (Secret Encapsulation)
 */

import { readVaultBlob, unwrapPrivateJwkWithPin } from '@/lib/vault'
import { importEcdsaPrivateKeyForSign, signUtf8WithEcdsaP256 } from '@/lib/crypto'

export type ExtractedVault =
  | { kind: 'V2'; ecdsaJwk: string; ecdhJwk: string }
  | { kind: 'LEGACY'; ecdhJwk: string }

/**
 * Unlock the vault with a PIN, extract the ECDSA private key, and sign the message.
 * Used for operations requiring proof-of-vault (e.g. avatar upload).
 */
export async function signMessageWithVaultPin(
  userId: string,
  vaultPin: string,
  message: string
): Promise<string> {
  const blob = readVaultBlob(userId)
  if (!blob) throw new Error('VAULT_NOT_FOUND')

  const plaintext = await unwrapPrivateJwkWithPin(blob, vaultPin)
  const parsed = extractVaultPayload(plaintext)
  if (!parsed) throw new Error('VAULT_PAYLOAD_INVALID')

  const ecdsaJwk = parsed.kind === 'V2' ? parsed.ecdsaJwk : null
  if (!ecdsaJwk) throw new Error('ECDSA_KEY_MISSING_IN_VAULT')

  const signingKey = await importEcdsaPrivateKeyForSign(ecdsaJwk)
  return signUtf8WithEcdsaP256(signingKey, message)
}

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
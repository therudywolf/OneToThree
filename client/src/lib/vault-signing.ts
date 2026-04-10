import {
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import { readVaultBlob, unwrapPrivateJwkWithPin } from '@/lib/vault'

export async function signMessageWithVaultPin(
  userId: string,
  pin: string,
  message: string
): Promise<string> {
  const blob = readVaultBlob(userId)
  if (!blob) {
    throw new Error('NO_VAULT')
  }
  const plain = await unwrapPrivateJwkWithPin(blob, pin)
  const parsed = parseVaultPlaintext(plain)
  if (!parsed || parsed.kind !== 'v2') {
    throw new Error('LEGACY_VAULT_NO_SIGNING')
  }
  const key = await importEcdsaPrivateKeyForSign(parsed.ecdsaPrivateJwk)
  return signUtf8WithEcdsaP256(key, message)
}

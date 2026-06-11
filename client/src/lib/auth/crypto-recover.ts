// Account recovery (Option A) — login-side flow.
//
// Reconstructs the local vault from the server-held recovery blob using only
// the user's 24-word recovery phrase, re-seals it under a NEW vault password,
// then hands off to the normal login. The phrase never leaves the device; the
// server only ever returns opaque ciphertext after verifying a phrase-signed
// nonce.

import { completeRecovery, fetchRecoveryChallenge } from '@/lib/api/recovery'
import {
  deriveRecoveryAuthKeypair,
  normalizeRecoveryMnemonic,
  validateRecoveryMnemonic,
} from '@/lib/recovery/recovery-secret'
import { importEcdsaPrivateKeyForSign, signUtf8WithEcdsaP256 } from '@/lib/crypto'
import { persistVaultBlobByLoginUsername, unwrapPrivateJwkWithPin, wrapPrivateJwkWithPin, type VaultBlob } from '@/lib/vault'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import { parseNickname } from '@/lib/nickname'
import { cryptoLogin, type CryptoLoginResult } from '@/lib/auth/crypto-login'

export type RecoverParams = {
  username: string
  phrase: string
  /** New vault password to seal the recovered keyring under. */
  newPassword: string
  /** Required only when the account opted into TOTP-gated recovery. */
  totpCode?: string
}

export async function recoverWithPhrase(params: RecoverParams): Promise<CryptoLoginResult> {
  const nick = parseNickname(params.username.trim())
  if (!nick.ok) return { ok: false, error: nick.error }
  const username = nick.value

  if (!validateRecoveryMnemonic(params.phrase)) return { ok: false, error: 'RECOVERY_PHRASE_INVALID' }
  if (params.newPassword.length < 8) return { ok: false, error: 'PIN_MIN_8' }
  const phrase = normalizeRecoveryMnemonic(params.phrase)

  // [1] Prove possession of the phrase → server releases the ciphertext blob.
  let recoveryBlobStr: string
  try {
    const { privateJwk } = deriveRecoveryAuthKeypair(phrase)
    const nonce = await fetchRecoveryChallenge(username)
    const signingKey = await importEcdsaPrivateKeyForSign(privateJwk)
    const signature = await signUtf8WithEcdsaP256(signingKey, nonce)
    const res = await completeRecovery({ username, nonce, signature, totpCode: params.totpCode })
    recoveryBlobStr = res.recovery_vault_blob
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'RECOVERY_COMPLETE_FAILED' }
  }

  // [2] Decrypt the keyring with the phrase, re-seal under the new password,
  //     and persist locally so the standard login can unlock it.
  try {
    const blob = JSON.parse(recoveryBlobStr) as VaultBlob
    const keyring = await unwrapPrivateJwkWithPin(blob, phrase)
    const parsed = parseVaultPlaintext(keyring)
    if (!parsed || parsed.kind !== 'V2') return { ok: false, error: 'INVALID_VAULT_FORMAT' }
    const newBlob = await wrapPrivateJwkWithPin(keyring, params.newPassword)
    persistVaultBlobByLoginUsername(username, newBlob)
  } catch {
    return { ok: false, error: 'RECOVERY_DECRYPT_FAILED' }
  }

  // [3] Normal login with the new password: signs the challenge with the
  //     recovered identity key, re-uploads ECDH, and (post-login) syncs the
  //     re-sealed vault to the server. The phrase-sealed recovery blob is
  //     unaffected, so recovery keeps working with the same phrase.
  return cryptoLogin({ username, vaultPassword: params.newPassword, mode: 'login' })
}

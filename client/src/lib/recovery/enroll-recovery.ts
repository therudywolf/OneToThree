// Recovery-phrase enrollment (Option A) — shared between Settings and the
// post-registration onboarding step so there is ONE source of truth for the
// client-only crypto. Everything here runs on the device; only the sealed
// ciphertext blob + the phrase-derived PUBLIC key ever leave it. The 24-word
// phrase itself is never transmitted.
//
// Flow mirrors settings-modal's begin/confirm split so the UI can show the
// phrase and gate on "I saved it" before the account is actually enrolled.

import { readVaultBlob, wrapPrivateJwkWithPin, unwrapPrivateJwkWithPin } from '@/lib/vault'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import { importEcdsaPrivateKeyForSign, signUtf8WithEcdsaP256 } from '@/lib/crypto'
import {
  generateRecoveryMnemonic,
  deriveRecoveryAuthKeypair,
  RECOVERY_ARGON2_PARAMS,
} from '@/lib/recovery/recovery-secret'
import { getRecoverySetupChallenge, enableRecovery } from '@/lib/api/recovery'

export type RecoveryEnrollment = {
  /** The 24-word recovery phrase to show the user once. Never leaves the device. */
  mnemonic: string
  /** The keyring re-sealed under the phrase (JSON), uploaded on commit. */
  recoveryBlob: string
  /** Phrase-derived auth public key (JWK), uploaded on commit. */
  publicJwk: string
  /** Login device key, used to prove vault-unlock on commit. Kept in memory only. */
  ecdsaPrivateJwk: string
}

/**
 * Generate a fresh recovery phrase and seal a SECOND copy of the unlocked
 * keyring under it. Verifies the seal round-trips before returning, so a
 * silently-bricked recovery can never be enrolled. Requires the vault password
 * (the same one just used to register / unlock on this device).
 *
 * Returns the enrollment material; nothing is uploaded yet — call
 * {@link commitRecoveryEnrollment} after the user confirms they saved the phrase.
 */
export async function prepareRecoveryEnrollment(
  userId: string,
  vaultPassword: string
): Promise<RecoveryEnrollment> {
  const blob = readVaultBlob(userId)
  if (!blob) throw new Error('NO_LOCAL_VAULT')
  const keyring = await unwrapPrivateJwkWithPin(blob, vaultPassword)
  const parsed = parseVaultPlaintext(keyring)
  if (!parsed || parsed.kind !== 'V2') throw new Error('INVALID_VAULT_FORMAT')

  const mnemonic = generateRecoveryMnemonic()
  const { publicJwk } = deriveRecoveryAuthKeypair(mnemonic)
  // Light Argon2 — a 256-bit phrase needs no heavy stretching, so this stays
  // fast even in mobile WebViews. The login vault keeps the heavy default.
  const recoveryBlob = await wrapPrivateJwkWithPin(keyring, mnemonic, RECOVERY_ARGON2_PARAMS)
  // Self-check before we ever upload: the sealed blob MUST decrypt back to the
  // same keyring with the phrase, or recovery would be silently bricked.
  if ((await unwrapPrivateJwkWithPin(recoveryBlob, mnemonic)) !== keyring) {
    throw new Error('RECOVERY_SELF_CHECK_FAILED')
  }

  return {
    mnemonic,
    recoveryBlob: JSON.stringify(recoveryBlob),
    publicJwk,
    ecdsaPrivateJwk: parsed.ecdsaJwk,
  }
}

/**
 * Finalize enrollment: prove vault-unlock by signing a fresh server nonce with
 * the login device key, then upload the recovery blob + phrase-derived pubkey.
 * A bare stolen session can't sign the proof, so it can't enroll recovery.
 */
export async function commitRecoveryEnrollment(
  enrollment: RecoveryEnrollment,
  requireTotp: boolean
): Promise<void> {
  const nonce = await getRecoverySetupChallenge()
  const key = await importEcdsaPrivateKeyForSign(enrollment.ecdsaPrivateJwk)
  const proof_signature = await signUtf8WithEcdsaP256(key, nonce)
  await enableRecovery({
    recovery_vault_blob: enrollment.recoveryBlob,
    recovery_auth_pub_jwk: enrollment.publicJwk,
    require_totp: requireTotp,
    proof_nonce: nonce,
    proof_signature,
  })
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Account-recovery secret (the "recovery phrase").
// ---------------------------------------------------------------------------
// A 256-bit BIP39 mnemonic generated ENTIRELY on the client — the server never
// sees it. From it we derive deterministically:
//
//   1. A wrap key (reusing vault.ts's Argon2id+AES-GCM path, fed the mnemonic
//      as the "password") that seals a SECOND copy of the keyring →
//      `recovery_vault_blob`, stored on the server as opaque ciphertext.
//   2. An ECDSA P-256 keypair whose PUBLIC half is uploaded to the server. To
//      recover, the client signs a server nonce with the derived private key,
//      proving knowledge of the phrase WITHOUT revealing it — the same
//      challenge/verify crypto used at login. The server then releases the
//      ciphertext blob, which only the phrase can decrypt.
//
// Result: full account recovery (incl. forgotten password) with zero server
// key-escrow — a fully-compromised server holds only ciphertext + a public key
// and still cannot decrypt the vault. The phrase's 256-bit entropy makes the
// stored blob brute-force-infeasible without an enclave/rate-limiter.
// ---------------------------------------------------------------------------

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { p256 } from '@noble/curves/p256'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'

/** 256-bit entropy → 24-word phrase (with the BIP39 checksum that catches typos). */
const RECOVERY_ENTROPY_BITS = 256

/**
 * Argon2id parameters for the recovery vault blob (NOT the login vault).
 *
 * The recovery phrase carries a full 256 bits of entropy, so brute-forcing it is
 * infeasible no matter how cheap the KDF is — the heavy 64 MiB Argon2 used for
 * user-chosen vault passwords buys essentially nothing here while making the
 * seal/unseal painfully slow in mobile WebViews (pure-JS Argon2). These lighter
 * params keep enable/recover fast without weakening the 256-bit guarantee.
 * (Unwrap auto-detects params from the blob, so existing blobs keep working.)
 */
export const RECOVERY_ARGON2_PARAMS = { t: 2, m: 8 * 1024, p: 1 } as const

function bytesToB64url(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Trim + collapse whitespace + lowercase so re-typed phrases match canonically. */
export function normalizeRecoveryMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Generate a fresh 24-word recovery phrase. CLIENT-ONLY — never sent anywhere. */
export function generateRecoveryMnemonic(): string {
  return generateMnemonic(wordlist, RECOVERY_ENTROPY_BITS)
}

/** True iff the phrase is a valid 24-word BIP39 mnemonic (checksum included). */
export function validateRecoveryMnemonic(mnemonic: string): boolean {
  try {
    return validateMnemonic(normalizeRecoveryMnemonic(mnemonic), wordlist)
  } catch {
    return false
  }
}

export type RecoveryAuthKeypair = {
  /** ECDSA P-256 private JWK — derived locally, used to sign the recovery nonce. */
  privateJwk: string
  /** ECDSA P-256 public JWK — uploaded to the server as the recovery authorizer. */
  publicJwk: string
}

/**
 * Deterministically derive the ECDSA P-256 keypair that proves knowledge of the
 * recovery phrase. Same phrase → same keypair, on any device, with no server
 * involvement. The server stores only the public JWK.
 */
export function deriveRecoveryAuthKeypair(mnemonic: string): RecoveryAuthKeypair {
  const seed = mnemonicToSeedSync(normalizeRecoveryMnemonic(mnemonic))
  // HKDF the seed into a valid P-256 scalar. The reject-loop covers the
  // negligible (~2^-128) chance the 32 bytes land >= the curve order.
  let priv: Uint8Array
  let counter = 0
  do {
    priv = hkdf(sha256, seed, undefined, `p13/recovery/auth/v1/${counter++}`, 32)
  } while (!p256.utils.isValidPrivateKey(priv))

  const pub = p256.getPublicKey(priv, false) // 0x04 || X(32) || Y(32)
  const x = bytesToB64url(pub.slice(1, 33))
  const y = bytesToB64url(pub.slice(33, 65))
  const d = bytesToB64url(priv)

  return {
    privateJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', d, x, y, ext: true }),
    publicJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x, y, ext: true }),
  }
}

/**
 * Ratchet key types and helpers.
 *
 * We use two Curve25519-family primitives from @noble/curves:
 *   - `x25519`  — ECDH key agreement (identity root, signed pre-key, ephemeral ratchet keys).
 *   - `ed25519` — EdDSA signatures over pre-key bundles (identity signing key).
 *
 * All keys are stored as raw 32-byte Uint8Arrays. Serialization uses
 * base64url for compactness on the wire and `btoa` in tests.
 *
 * Cryptographic invariants:
 *   - Identity key pairs are long-lived and must live only in the vault (never in IDB).
 *   - Signed pre-keys rotate every ~7 days (TBD by server).
 *   - One-time pre-keys are consumed exactly once by the responder side.
 *   - Double Ratchet ephemeral keys are regenerated on every DH ratchet step.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519'

export type RawKey = Uint8Array

export interface KeyPair {
  privateKey: RawKey
  publicKey: RawKey
}

export interface IdentityKeyPair {
  /** Ed25519 signing key (sk + pk, 32 bytes each). */
  signing: KeyPair
  /** Derived X25519 exchange key (used for X3DH/DR). */
  exchange: KeyPair
}

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length)
  crypto.getRandomValues(buf)
  return buf
}

export function generateX25519KeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey()
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

export function generateEd25519KeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomSecretKey()
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

/**
 * Generate a fresh identity. Two independent key pairs are generated:
 * one for Ed25519 signatures (identity trust anchor) and one for X25519
 * (ECDH root). Keeping them separate is the modern Signal / MLS approach
 * and avoids ambiguity when selecting a mode (sign vs ECDH).
 */
export function generateIdentity(): IdentityKeyPair {
  return {
    signing: generateEd25519KeyPair(),
    exchange: generateX25519KeyPair(),
  }
}

export function signWithIdentity(
  identity: IdentityKeyPair,
  message: Uint8Array
): Uint8Array {
  return ed25519.sign(message, identity.signing.privateKey)
}

export function verifyIdentitySignature(
  identityPublicSigning: RawKey,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, identityPublicSigning)
  } catch {
    return false
  }
}

export function dh(
  ourPrivate: RawKey,
  theirPublic: RawKey
): Uint8Array {
  return x25519.getSharedSecret(ourPrivate, theirPublic)
}

const IDENTITY_EXCHANGE_SIG_DOMAIN = new TextEncoder().encode('ForestMsg/x3dh/idex/1:')

/**
 * Bytes the Ed25519 identity key signs to bind the X25519 `identityExchange`
 * key (used in X3DH DH2/DH4) to that identity. Without this binding a malicious
 * key server could substitute `identityExchange` and silently MITM the
 * handshake — the signed pre-key signature alone never covers it (D4).
 */
export function identityExchangeSigningMessage(exchangePublicKey: RawKey): Uint8Array {
  const out = new Uint8Array(IDENTITY_EXCHANGE_SIG_DOMAIN.length + exchangePublicKey.length)
  out.set(IDENTITY_EXCHANGE_SIG_DOMAIN)
  out.set(exchangePublicKey, IDENTITY_EXCHANGE_SIG_DOMAIN.length)
  return out
}

/** Sign one's own `identityExchange` public key with the Ed25519 identity key. */
export function signIdentityExchange(identity: IdentityKeyPair): Uint8Array {
  return signWithIdentity(identity, identityExchangeSigningMessage(identity.exchange.publicKey))
}

/** Check that two keys match in constant time. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

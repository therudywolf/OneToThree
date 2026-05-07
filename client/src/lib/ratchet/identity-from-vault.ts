'use client'

/**
 * Derives stable Ed25519 (signing) + X25519 (exchange) Double Ratchet identity
 * keys from the vault's ECDH P-256 private key via HKDF-SHA256.
 *
 * Using derivation (rather than independent random generation) means:
 *   - No extra vault fields: the single ecdhJwk already stored is the root secret.
 *   - Keys are deterministic: vault unlock always reproduces the same DR identity.
 *   - Cross-device: any device with the same vault produces identical public keys.
 */
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { signWithIdentity, type IdentityKeyPair, type KeyPair } from './keys'

const ENC = new TextEncoder()

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const bin = atob(padded + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface DerivedDrBundle {
  identity: IdentityKeyPair
  /** Single stable signed pre-key (id = 1, rotated only on vault migration). */
  signedPreKey: KeyPair
  signedPreKeyId: number
  signedPreKeySignature: Uint8Array
}

/**
 * Derive one OTP private key by id (1-based). Deterministic: same vault → same key.
 * Alice consumes an OTP id from the server bundle; Bob re-derives the private key here.
 *
 * @deprecated OTP prekeys must be randomly generated, not derived.
 * Use generateX25519KeyPair() and store private keys in the local bundle.
 * This function remains only for migration of old sessions.
 */
export function deriveOtpPrivKey(dBytes: Uint8Array, id: number): Uint8Array {
  const idBuf = ENC.encode(String(id))
  return hkdf(
    sha256,
    dBytes,
    ENC.encode('p13:dr:otp:v1:salt'),
    new Uint8Array([...ENC.encode('p13:dr:otp:'), ...idBuf]),
    32
  )
}

/**
 * Derive a batch of OTP key pairs [startId, startId+count).
 */
export function deriveOtpBatch(
  dBytes: Uint8Array,
  startId: number,
  count: number
): Array<{ id: number; keypair: KeyPair }> {
  return Array.from({ length: count }, (_, i) => {
    const id = startId + i
    const priv = deriveOtpPrivKey(dBytes, id)
    return { id, keypair: { privateKey: priv, publicKey: x25519.getPublicKey(priv) } }
  })
}

/** Extract the raw P-256 private scalar from a JWK string. */
export function extractEcdhDBytes(ecdhJwk: string): Uint8Array {
  const jwk = JSON.parse(ecdhJwk) as { d?: string }
  if (!jwk.d) throw new Error('DR_DERIVE_MISSING_D')
  return b64urlDecode(jwk.d)
}

/**
 * Derive a full DR identity bundle from the vault ECDH JWK string.
 * The `d` field of the JWK (P-256 private scalar) is the HKDF input key.
 */
export function deriveDrBundleFromEcdhJwk(ecdhJwk: string): DerivedDrBundle {
  const jwk = JSON.parse(ecdhJwk) as { d?: string; crv?: string }
  if (!jwk.d) throw new Error('DR_DERIVE_MISSING_D')

  const dBytes = b64urlDecode(jwk.d)
  // 96 bytes: 32 signing seed | 32 exchange seed | 32 spk seed
  const seed = hkdf(
    sha256,
    dBytes,
    ENC.encode('p13:dr:v1:salt'),
    ENC.encode('p13:dr:identity:v1'),
    96
  )

  const signingSeed  = seed.slice(0, 32)
  const exchangeSeed = seed.slice(32, 64)
  const spkSeed      = seed.slice(64, 96)

  const identity: IdentityKeyPair = {
    signing:  { privateKey: signingSeed,  publicKey: ed25519.getPublicKey(signingSeed) },
    exchange: { privateKey: exchangeSeed, publicKey: x25519.getPublicKey(exchangeSeed) },
  }

  const signedPreKey: KeyPair = {
    privateKey: spkSeed,
    publicKey:  x25519.getPublicKey(spkSeed),
  }

  const signedPreKeySignature = signWithIdentity(identity, signedPreKey.publicKey)

  return { identity, signedPreKey, signedPreKeyId: 1, signedPreKeySignature }
}

/**
 * Derive an AES-GCM-256 key for wrapping DR session records in IndexedDB.
 * Keeps session state encrypted at rest without requiring the vault PIN.
 */
export async function deriveSessionWrapKey(identity: IdentityKeyPair): Promise<CryptoKey> {
  const raw = hkdf(
    sha256,
    identity.exchange.privateKey,
    ENC.encode('p13:dr:wrap:v1:salt'),
    ENC.encode('p13:dr:session-wrap:v1'),
    32
  )
  const keyMaterial = new Uint8Array(raw)
  return crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

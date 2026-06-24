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
import { signWithIdentity, signIdentityExchange, type IdentityKeyPair, type KeyPair } from './keys'

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
  /** Ed25519 signature over identityExchange by identitySigning (D4). */
  identityExchangeSignature: Uint8Array
}

/**
 * Per-device DR root secret.
 *
 * Track A4 makes the Double Ratchet per-device. The vault (and therefore
 * `dBytes`) is per-USER, so deriving the DR identity straight from `dBytes`
 * yields the SAME identity on every linked device — which is exactly what
 * breaks multi-device DR. Mixing the stable per-browser device id into an
 * HKDF expansion gives each device a DISTINCT 32-byte root secret while
 * staying fully deterministic (a device that re-imports the same vault and
 * keeps its device id reproduces the same DR identity, so no extra state has
 * to be persisted).
 *
 * The device id is opaque (uuid / random string); it never needs to be
 * secret — it is published as the X3DH bundle's `device_id` anyway. The
 * secrecy of the derived material rests entirely on `dBytes`.
 */
function deviceScopedRoot(dBytes: Uint8Array, deviceId: string): Uint8Array {
  return hkdf(
    sha256,
    dBytes,
    ENC.encode('p13:dr:device:v1:salt'),
    ENC.encode(`p13:dr:device:${deviceId}`),
    32
  )
}

/**
 * Derive one OTP private key by id (1-based). Deterministic: same vault +
 * device → same key. Alice consumes an OTP id from the server bundle; Bob
 * re-derives the private key here.
 *
 * `dRoot` is the per-device root secret (`deviceScopedRoot`) — NOT the raw
 * vault `dBytes` — so each device owns an independent OTP space.
 */
export function deriveOtpPrivKey(dRoot: Uint8Array, id: number): Uint8Array {
  const idBuf = ENC.encode(String(id))
  return hkdf(
    sha256,
    dRoot,
    ENC.encode('p13:dr:otp:v1:salt'),
    new Uint8Array([...ENC.encode('p13:dr:otp:'), ...idBuf]),
    32
  )
}

/**
 * Derive a batch of OTP key pairs [startId, startId+count) from a per-device
 * root secret.
 */
export function deriveOtpBatch(
  dRoot: Uint8Array,
  startId: number,
  count: number
): Array<{ id: number; keypair: KeyPair }> {
  return Array.from({ length: count }, (_, i) => {
    const id = startId + i
    const priv = deriveOtpPrivKey(dRoot, id)
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
 * Compute the per-device DR root secret straight from the vault ECDH JWK.
 * Callers feed this into `deriveOtpPrivKey` / `deriveOtpBatch`.
 */
export function deriveDeviceDrRoot(ecdhJwk: string, deviceId: string): Uint8Array {
  return deviceScopedRoot(extractEcdhDBytes(ecdhJwk), deviceId)
}

/**
 * Derive a full DR identity bundle from the vault ECDH JWK string, scoped to
 * a single device.
 *
 * `deviceId` is mixed in (via `deviceScopedRoot`) so every linked device of
 * the same user produces a DISTINCT identity / signed-prekey / OTP space.
 * This is the cornerstone of per-device Double Ratchet: each device publishes
 * its own bundle to the device-scoped `/keys/*` directory.
 *
 * The `d` field of the JWK (P-256 private scalar) is the secret root; the
 * device id only diversifies the expansion and need not be secret.
 */
export function deriveDrBundleFromEcdhJwk(
  ecdhJwk: string,
  deviceId: string
): DerivedDrBundle {
  const jwk = JSON.parse(ecdhJwk) as { d?: string; crv?: string }
  if (!jwk.d) throw new Error('DR_DERIVE_MISSING_D')
  if (!deviceId) throw new Error('DR_DERIVE_MISSING_DEVICE_ID')

  const dRoot = deviceScopedRoot(b64urlDecode(jwk.d), deviceId)
  // 96 bytes: 32 signing seed | 32 exchange seed | 32 spk seed
  const seed = hkdf(
    sha256,
    dRoot,
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
  const identityExchangeSignature = signIdentityExchange(identity)

  return { identity, signedPreKey, signedPreKeyId: 1, signedPreKeySignature, identityExchangeSignature }
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

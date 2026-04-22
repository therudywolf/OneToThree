/**
 * X3DH (Extended Triple Diffie-Hellman) — Signal's asymmetric handshake used
 * to bootstrap a Double Ratchet session. Only the essentials are here;
 * the server-facing pre-key bundle schema lives in phase 3.2.
 *
 *   Initiator (Alice):
 *     DH1 = DH(IK_a, SPK_b)
 *     DH2 = DH(EK_a, IK_b)
 *     DH3 = DH(EK_a, SPK_b)
 *     DH4 = DH(EK_a, OPK_b)   // when an OPK is available
 *     sharedSecret = HKDF( DH1 || DH2 || DH3 || DH4 )
 *
 *   Responder (Bob) runs the mirrored computation with his private keys.
 */
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import {
  dh,
  type IdentityKeyPair,
  type KeyPair,
  type RawKey,
  verifyIdentitySignature,
} from './keys'

const ENC = new TextEncoder()
const X3DH_INFO = ENC.encode('ForestMsg/x3dh/1')

export interface PreKeyBundle {
  userId: string
  /** Ed25519 public key. */
  identitySigning: RawKey
  /** X25519 public key (derived identity, used for X3DH DH2). */
  identityExchange: RawKey
  /** Signed pre-key — rotates every ~7 days. */
  signedPreKey: {
    id: number
    publicKey: RawKey
    signature: Uint8Array
  }
  /** One-time pre-key consumed atomically by the initiator request. */
  oneTimePreKey: {
    id: number
    publicKey: RawKey
  } | null
}

export function verifyBundleSignature(bundle: PreKeyBundle): boolean {
  return verifyIdentitySignature(
    bundle.identitySigning,
    bundle.signedPreKey.publicKey,
    bundle.signedPreKey.signature
  )
}

export interface X3dhInitiator {
  initiatorIdentity: IdentityKeyPair
  ephemeral: KeyPair
  bundle: PreKeyBundle
}

export interface X3dhResponder {
  responderIdentity: IdentityKeyPair
  signedPreKey: KeyPair
  oneTimePreKey: KeyPair | null
  initiatorIdentityPublic: RawKey
  initiatorEphemeralPublic: RawKey
}

function derive(
  dhOutputs: Uint8Array[],
  ikm?: Uint8Array
): { sharedSecret: Uint8Array } {
  let total = 0
  for (const b of dhOutputs) total += b.length
  const joined = new Uint8Array(total)
  let off = 0
  for (const b of dhOutputs) {
    joined.set(b, off)
    off += b.length
  }
  const sharedSecret = hkdf(
    sha256,
    joined,
    ikm ?? new Uint8Array(32),
    X3DH_INFO,
    32
  )
  return { sharedSecret }
}

/**
 * Initiator side — produce the shared secret Bob will reconstruct.
 * Throws if the signed pre-key signature does not verify against Bob's
 * identity key, which would indicate an active server MITM.
 */
export function x3dhInitiator(args: X3dhInitiator): { sharedSecret: Uint8Array } {
  if (!verifyBundleSignature(args.bundle)) {
    throw new Error('X3DH_BAD_SPK_SIGNATURE')
  }
  const dh1 = dh(args.initiatorIdentity.exchange.privateKey, args.bundle.signedPreKey.publicKey)
  const dh2 = dh(args.ephemeral.privateKey, args.bundle.identityExchange)
  const dh3 = dh(args.ephemeral.privateKey, args.bundle.signedPreKey.publicKey)
  const dhList: Uint8Array[] = [dh1, dh2, dh3]
  if (args.bundle.oneTimePreKey) {
    dhList.push(dh(args.ephemeral.privateKey, args.bundle.oneTimePreKey.publicKey))
  }
  return derive(dhList)
}

/**
 * Responder side — recreates the same shared secret on first message receipt.
 */
export function x3dhResponder(args: X3dhResponder): { sharedSecret: Uint8Array } {
  const dh1 = dh(args.signedPreKey.privateKey, args.initiatorIdentityPublic)
  const dh2 = dh(args.responderIdentity.exchange.privateKey, args.initiatorEphemeralPublic)
  const dh3 = dh(args.signedPreKey.privateKey, args.initiatorEphemeralPublic)
  const dhList: Uint8Array[] = [dh1, dh2, dh3]
  if (args.oneTimePreKey) {
    dhList.push(dh(args.oneTimePreKey.privateKey, args.initiatorEphemeralPublic))
  }
  return derive(dhList)
}

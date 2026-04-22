/**
 * KDF helpers for the Double Ratchet.
 *
 * All key derivation follows the Signal spec
 *   https://signal.org/docs/specifications/doubleratchet/
 * using HKDF-SHA256 with:
 *
 *   RootKDF:  HKDF(dhOut, prevRootKey, "ForestMsg/root/1") -> (rootKey, chainKey)
 *   ChainKDF: per-chain HMAC derivation to avoid revealing keys in stored chains.
 *
 * These constants are domain-separation tags and MUST NOT change without a
 * `protocol_version` bump.
 */
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'

const ENC = new TextEncoder()

export const ROOT_INFO = ENC.encode('ForestMsg/root/1')
export const SEND_CHAIN_INFO = ENC.encode('ForestMsg/chain/send/1')
export const RECV_CHAIN_INFO = ENC.encode('ForestMsg/chain/recv/1')

const MSG_SUBKEY = new Uint8Array([0x01])
const NEXT_CHAIN_SUBKEY = new Uint8Array([0x02])

export function rootKdf(
  rootKey: Uint8Array,
  dhOutput: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdf(sha256, dhOutput, rootKey, ROOT_INFO, 64)
  return {
    rootKey: okm.slice(0, 32),
    chainKey: okm.slice(32, 64),
  }
}

export function kdfMessageKey(chainKey: Uint8Array): {
  messageKey: Uint8Array
  nextChainKey: Uint8Array
} {
  return {
    messageKey: hmac(sha256, chainKey, MSG_SUBKEY),
    nextChainKey: hmac(sha256, chainKey, NEXT_CHAIN_SUBKEY),
  }
}

/**
 * Derive the (AES key || AES IV || HMAC key) triple the message key uses for
 * AES-256-GCM ciphertext. GCM binds auth directly into the key, so we only
 * need 32 bytes for key + 12 bytes for IV.
 */
export function deriveMessageAead(messageKey: Uint8Array): {
  aesKey: Uint8Array
  iv: Uint8Array
} {
  const okm = hkdf(
    sha256,
    messageKey,
    new Uint8Array(32),
    ENC.encode('ForestMsg/msg/1'),
    44
  )
  return {
    aesKey: okm.slice(0, 32),
    iv: okm.slice(32, 44),
  }
}

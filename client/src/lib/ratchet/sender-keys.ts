/**
 * Sender Keys — Signal-style group messaging primitive.
 *
 * Each group member has a `SenderChain` that yields message keys by HMAC
 * ratcheting. Members share only a snapshot of the current chain key with
 * other members via the pairwise Double Ratchet, then evolve their chain
 * locally. Members rotate their sender chain on group changes (add/remove)
 * to maintain post-compromise security of group metadata.
 *
 * NOTE: this is a small self-contained implementation — it does not yet
 * include the signature-verification layer (Ed25519 over ciphertext) that
 * full Signal Sender Keys mandate. That layer will be wired in phase 3.3
 * where `identityKeys.signing` is reused to sign ciphertext envelopes.
 */
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'

const ENC = new TextEncoder()
const MSG = new Uint8Array([0x01])
const CHAIN = new Uint8Array([0x02])

export interface SenderChain {
  senderId: string
  chainKey: Uint8Array
  counter: number
}

export function createSenderChain(
  senderId: string,
  seed: Uint8Array
): SenderChain {
  const chainKey = hkdf(sha256, seed, new Uint8Array(32), ENC.encode('ForestMsg/sender/1'), 32)
  return { senderId, chainKey, counter: 0 }
}

export function advanceSenderChain(state: SenderChain): {
  messageKey: Uint8Array
  counter: number
} {
  const messageKey = hmac(sha256, state.chainKey, MSG)
  const nextChain = hmac(sha256, state.chainKey, CHAIN)
  state.chainKey = nextChain
  const counter = state.counter
  state.counter += 1
  return { messageKey, counter }
}

export function fastForwardSenderChain(
  state: SenderChain,
  target: number
): Uint8Array {
  if (target < state.counter) {
    throw new Error('SENDER_CHAIN_BACKWARD')
  }
  while (state.counter < target) {
    const next = hmac(sha256, state.chainKey, CHAIN)
    state.chainKey = next
    state.counter += 1
  }
  const messageKey = hmac(sha256, state.chainKey, MSG)
  const nextChain = hmac(sha256, state.chainKey, CHAIN)
  state.chainKey = nextChain
  state.counter += 1
  return messageKey
}

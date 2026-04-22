/**
 * Safety Numbers — stable, human-verifiable fingerprint of a pair of
 * identities. Mirrors Signal's 60-digit format but uses base-10 instead of
 * base-2^16 for compact, voice-readable output.
 *
 * Input invariant (order independent!): we sort the two identity public
 * keys lexicographically so Alice and Bob compute the exact same digits.
 *
 * Output: 60-digit string, groups of 5 ("12345 67890 …"). Matches the
 * conventional UX of Signal's "safety number" screen.
 */
import { sha512 } from '@noble/hashes/sha2'
import { constantTimeEqual } from './keys'

const ITERATIONS = 5200
const GROUP_COUNT = 12
const DIGITS_PER_GROUP = 5
const CHUNK_SIZE = 5 // 5 bytes -> 5-digit decimal group

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

function derive(
  left: Uint8Array,
  right: Uint8Array
): Uint8Array {
  const [first, second] = cmp(left, right) <= 0 ? [left, right] : [right, left]
  let hash = concat([first, second])
  for (let i = 0; i < ITERATIONS; i += 1) {
    hash = sha512(hash)
  }
  return hash
}

function encodeGroup(chunk: Uint8Array): string {
  let value = 0
  for (let i = 0; i < chunk.length; i += 1) {
    value = value * 256 + chunk[i]
  }
  value %= 100000
  return String(value).padStart(DIGITS_PER_GROUP, '0')
}

/**
 * Compute the user-facing safety number. Both identities must use the same
 * serialization (X25519 exchange public key, 32 bytes). The resulting
 * string is 72 chars including spaces.
 */
export function computeSafetyNumber(
  identityA: Uint8Array,
  identityB: Uint8Array
): string {
  const digest = derive(identityA, identityB)
  if (digest.length < CHUNK_SIZE * GROUP_COUNT) {
    throw new Error('SAFETY_NUMBER_DIGEST_TRUNCATED')
  }
  const groups: string[] = []
  for (let i = 0; i < GROUP_COUNT; i += 1) {
    groups.push(
      encodeGroup(digest.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
    )
  }
  return groups.join(' ')
}

/** Compare two safety numbers in constant time. */
export function safetyNumberEquals(a: string, b: string): boolean {
  const enc = new TextEncoder()
  return constantTimeEqual(enc.encode(a), enc.encode(b))
}

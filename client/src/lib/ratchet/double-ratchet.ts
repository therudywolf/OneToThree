/**
 * Double Ratchet — minimal Signal-compatible state machine.
 *
 * Only the pieces required by the messenger protocol are implemented:
 *   - Symmetric send/receive chains with HMAC chain KDF.
 *   - DH ratchet triggered on `publicKey` change in the received header.
 *   - Skipped message key cache to tolerate out-of-order delivery up to
 *     `maxSkip` messages per chain (hard-capped to avoid DoS).
 *
 * Not yet implemented:
 *   - Header encryption (HE variant).
 *   - Group (Sender Keys) — see `sender-keys.ts`.
 *   - Persistence across reload — see `session-store.ts`.
 */
import { sha256 } from '@noble/hashes/sha2'
import { dh, generateX25519KeyPair, type KeyPair, type RawKey } from './keys'
import { kdfMessageKey, rootKdf, deriveMessageAead } from './kdf'

export interface RatchetHeader {
  /** Sender's current DH ratchet public key. */
  dhPub: RawKey
  /** Previous-chain length (N) so the receiver can skip missing msgs. */
  previousChainLength: number
  /** Message counter within the current chain. */
  counter: number
}

export interface RatchetMessage {
  header: RatchetHeader
  ciphertext: Uint8Array
}

export type SkippedKeyBucket = Map<number, Uint8Array>

export interface RatchetState {
  /** Our DH sending pair (rotates on each DH ratchet step we initiate). */
  dhSelf: KeyPair
  /** Peer's latest known DH public key. */
  dhRemote: RawKey | null
  rootKey: Uint8Array
  sendChain: Uint8Array | null
  recvChain: Uint8Array | null
  sendCounter: number
  recvCounter: number
  prevSendCounter: number
  /**
   * Map<base64url(dhPub), Map<counter, messageKey>>. We key by remote dhPub so
   * that skipped keys are tied to the chain in which they were derived.
   */
  skipped: Map<string, SkippedKeyBucket>
  /** Hard cap for skipped message keys to avoid memory/DoS. */
  maxSkip: number
}

export interface RatchetInitAlice {
  sharedSecret: Uint8Array
  remoteDhPublic: RawKey
  maxSkip?: number
}

export interface RatchetInitBob {
  sharedSecret: Uint8Array
  selfDh: KeyPair
  maxSkip?: number
}

const DEFAULT_MAX_SKIP = 1000
/**
 * Upper bound on total skipped message keys across every bucket in a single
 * session.  Without this a malicious peer could open many DH chains, each
 * with up to `maxSkip` skipped keys, and exhaust client memory.
 */
const GLOBAL_SKIP_CAP = 3_000

function totalSkipped(state: RatchetState): number {
  let n = 0
  for (const bucket of state.skipped.values()) n += bucket.size
  return n
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Initialise a ratchet state from Alice's side (she knows Bob's DH pubkey). */
export function initRatchetAsAlice(input: RatchetInitAlice): RatchetState {
  const dhSelf = generateX25519KeyPair()
  const dhOut = dh(dhSelf.privateKey, input.remoteDhPublic)
  const { rootKey, chainKey } = rootKdf(input.sharedSecret, dhOut)
  return {
    dhSelf,
    dhRemote: input.remoteDhPublic,
    rootKey,
    sendChain: chainKey,
    recvChain: null,
    sendCounter: 0,
    recvCounter: 0,
    prevSendCounter: 0,
    skipped: new Map(),
    maxSkip: input.maxSkip ?? DEFAULT_MAX_SKIP,
  }
}

/**
 * Initialise a ratchet state from Bob's side. Bob has already published his
 * DH pair (it was the SignedPreKey X3DH used); the first DH ratchet step
 * happens when Bob receives Alice's first message.
 */
export function initRatchetAsBob(input: RatchetInitBob): RatchetState {
  return {
    dhSelf: input.selfDh,
    dhRemote: null,
    rootKey: input.sharedSecret,
    sendChain: null,
    recvChain: null,
    sendCounter: 0,
    recvCounter: 0,
    prevSendCounter: 0,
    skipped: new Map(),
    maxSkip: input.maxSkip ?? DEFAULT_MAX_SKIP,
  }
}

/**
 * Helper — copy a `Uint8Array` (which TS now types with `ArrayBufferLike`)
 * into a freshly-allocated `ArrayBuffer` so the WebCrypto signatures are
 * happy. The copy is O(n) but messages are bounded by Signal's ~2MB envelope
 * ceiling so the overhead is negligible.
 */
function toArrayBuffer(src: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(src.byteLength)
  new Uint8Array(out).set(src)
  return out
}

async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    'AES-GCM',
    false,
    ['encrypt']
  )
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    cryptoKey,
    toArrayBuffer(plaintext)
  )
  return new Uint8Array(ct)
}

async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    'AES-GCM',
    false,
    ['decrypt']
  )
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    cryptoKey,
    toArrayBuffer(ciphertext)
  )
  return new Uint8Array(pt)
}

function headerAad(header: RatchetHeader): Uint8Array {
  const out = new Uint8Array(header.dhPub.length + 8)
  out.set(header.dhPub, 0)
  const view = new DataView(out.buffer, out.byteOffset + header.dhPub.length, 8)
  view.setUint32(0, header.previousChainLength >>> 0, false)
  view.setUint32(4, header.counter >>> 0, false)
  return out
}

export async function encryptRatchet(
  state: RatchetState,
  plaintext: Uint8Array,
  associatedData: Uint8Array = new Uint8Array()
): Promise<RatchetMessage> {
  if (!state.sendChain) {
    throw new Error('RATCHET_NO_SEND_CHAIN')
  }
  const { messageKey, nextChainKey } = kdfMessageKey(state.sendChain)
  state.sendChain = nextChainKey
  const counter = state.sendCounter
  state.sendCounter += 1

  const header: RatchetHeader = {
    dhPub: state.dhSelf.publicKey,
    previousChainLength: state.prevSendCounter,
    counter,
  }
  const { aesKey, iv } = deriveMessageAead(messageKey)
  const aad = concatBytes(associatedData, headerAad(header))
  const ciphertext = await aesGcmEncrypt(aesKey, iv, plaintext, aad)
  return { header, ciphertext }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * DH ratchet step on receive: we already have a new `dhRemote` from the
 * header. Derive a fresh recvChain, rotate our own DH pair, and derive a
 * fresh sendChain for outgoing messages.
 */
function dhRatchetStep(state: RatchetState, newRemote: RawKey): void {
  state.prevSendCounter = state.sendCounter
  state.sendCounter = 0
  state.recvCounter = 0
  state.dhRemote = newRemote

  // Ratchet in the RECV direction first — use current dhSelf.private × newRemote.
  const dhRecv = dh(state.dhSelf.privateKey, newRemote)
  const recv = rootKdf(state.rootKey, dhRecv)
  state.rootKey = recv.rootKey
  state.recvChain = recv.chainKey

  // Rotate our DH pair then ratchet the SEND direction.
  state.dhSelf = generateX25519KeyPair()
  const dhSend = dh(state.dhSelf.privateKey, newRemote)
  const send = rootKdf(state.rootKey, dhSend)
  state.rootKey = send.rootKey
  state.sendChain = send.chainKey
}

function fastEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function cacheSkipped(
  state: RatchetState,
  remote: RawKey,
  upTo: number
): void {
  if (!state.recvChain) return
  const bucketKey = bytesToB64(remote)
  let bucket = state.skipped.get(bucketKey)
  if (!bucket) {
    bucket = new Map()
    state.skipped.set(bucketKey, bucket)
  }
  while (state.recvCounter < upTo) {
    if (bucket.size >= state.maxSkip) {
      throw new Error('RATCHET_SKIP_LIMIT')
    }
    if (totalSkipped(state) >= GLOBAL_SKIP_CAP) {
      throw new Error('RATCHET_GLOBAL_SKIP_LIMIT')
    }
    const { messageKey, nextChainKey } = kdfMessageKey(state.recvChain)
    state.recvChain = nextChainKey
    bucket.set(state.recvCounter, messageKey)
    state.recvCounter += 1
  }
}

async function tryDecryptSkipped(
  state: RatchetState,
  header: RatchetHeader,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array | null> {
  const bucketKey = bytesToB64(header.dhPub)
  const bucket = state.skipped.get(bucketKey)
  if (!bucket) return null
  const mk = bucket.get(header.counter)
  if (!mk) return null
  const { aesKey, iv } = deriveMessageAead(mk)
  const pt = await aesGcmDecrypt(aesKey, iv, ciphertext, aad)
  bucket.delete(header.counter)
  if (bucket.size === 0) state.skipped.delete(bucketKey)
  return pt
}

export async function decryptRatchet(
  state: RatchetState,
  message: RatchetMessage,
  associatedData: Uint8Array = new Uint8Array()
): Promise<Uint8Array> {
  const aad = concatBytes(associatedData, headerAad(message.header))
  const fromSkipped = await tryDecryptSkipped(
    state,
    message.header,
    message.ciphertext,
    aad
  )
  if (fromSkipped) return fromSkipped

  if (!fastEqual(message.header.dhPub, state.dhRemote)) {
    if (state.dhRemote) {
      cacheSkipped(state, state.dhRemote, message.header.previousChainLength)
    }
    dhRatchetStep(state, message.header.dhPub)
  }

  cacheSkipped(state, message.header.dhPub, message.header.counter)

  if (!state.recvChain) {
    throw new Error('RATCHET_NO_RECV_CHAIN')
  }
  const { messageKey, nextChainKey } = kdfMessageKey(state.recvChain)
  state.recvChain = nextChainKey
  state.recvCounter += 1

  const { aesKey, iv } = deriveMessageAead(messageKey)
  return aesGcmDecrypt(aesKey, iv, message.ciphertext, aad)
}

/** Stable hash of the public DH state, for safety-number rendering. */
export function fingerprint(...pubs: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of pubs) total += p.length
  const joined = new Uint8Array(total)
  let off = 0
  for (const p of pubs) {
    joined.set(p, off)
    off += p.length
  }
  return sha256(joined)
}

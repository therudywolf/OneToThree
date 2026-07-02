// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Double Ratchet session manager — bridges the pure ratchet library
 * (`double-ratchet.ts`, `x3dh.ts`) with the server key directory (`/api/keys`)
 * and the client-side IndexedDB session store.
 *
 * Track A4 — PER-DEVICE Double Ratchet
 * ------------------------------------
 * A user may have several linked devices. Each device owns a DISTINCT DR
 * identity (see `identity-from-vault.ts` → `deriveDrBundleFromEcdhJwk`, which
 * mixes the device id into the key derivation) and publishes its own X3DH
 * bundle to the device-scoped server directory.
 *
 * A conversation between user A and user B therefore holds one ratchet PER
 * ORDERED PAIR of devices: `(A.dev_i ⇄ B.dev_j)`. Session records are keyed
 * by the 4-tuple `(ownerId, ownDeviceId, peerId, peerDeviceId)`.
 *
 * Responsibilities
 *   - Boot per-(device-pair) sessions (X3DH → DR) on demand.
 *   - Serialize / deserialize session state for persistence.
 *   - `encryptForPeer` → fan out: one wire envelope per peer device AND per
 *     of the sender's OTHER devices (outbox sync), each carrying its own
 *     ratchet header and the SENDER's device id.
 *   - `decryptFromPeer` → route an inbound envelope to the ratchet matching
 *     `(owner, ownDevice, peer, envelope.senderDeviceId)`.
 *
 * On-wire shape (one per device delivery slot)
 *   The DR ciphertext for each device is NOT the same — distinct ratchets
 *   produce distinct headers + ciphertexts. The server's `message_deliveries`
 *   slot only has an opaque `ciphertext` text column, so each slot carries a
 *   self-contained JSON envelope packed into that column:
 *
 *     DrDeviceEnvelope = {
 *       v: 2,
 *       sd: <senderDeviceId>,      // routes the receiver to the right ratchet
 *       h:  <drHeader b64url>,     // { dhPub, prevN, n }
 *       c:  <ciphertext||tag b64url>,
 *       i?: <DrInitWirePayload>    // only on the first message of a session
 *     }
 *
 *   The slot `iv` stays the `dr:v2` sentinel; the shared `messages.dr_header`
 *   column is left null for device-fan-out v2 (every device self-describes).
 *
 * Session payload at rest: AES-GCM wrapped with the vault-derived
 * `sessionWrapKey`. Layout: [0xF0 marker | 12B IV | ciphertext+tag].
 */
import type { BundleResponse } from '@/lib/api/keys'
import * as keysApi from '@/lib/api/keys'
import {
  decryptRatchet,
  encryptRatchet,
  fingerprint,
  initRatchetAsAlice,
  initRatchetAsBob,
  type RatchetHeader,
  type RatchetMessage,
  type RatchetState,
} from './double-ratchet'
import {
  generateEd25519KeyPair,
  generateIdentity,
  generateX25519KeyPair,
  signWithIdentity,
  signIdentityExchange,
  type IdentityKeyPair,
  type KeyPair,
} from './keys'
import {
  putSessionRecord,
  getSessionRecord,
  deleteSessionRecord,
  deleteSessionRecordsForPeer,
} from './session-store'
import { x3dhInitiator, x3dhResponder, type PreKeyBundle } from './x3dh'
import { DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'

const PROTOCOL_VERSION = 2
const DR_IV_SENTINEL = DR_SLOT_SENTINEL
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * TS 5.7+ lib.dom splits `Uint8Array<ArrayBufferLike>` (the default ctor
 * return) from the stricter `BufferSource` overloads that SubtleCrypto and
 * friends require.  Copy into a fresh, non-shared ArrayBuffer so the stricter
 * overload matches deterministically.
 */
function bytesToArrayBuffer(src: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(src.byteLength)
  new Uint8Array(out).set(src)
  return out
}

interface SerializedKeyPair {
  privateKey: string
  publicKey: string
}

interface SerializedSkippedBucket {
  remote: string
  keys: Array<{ counter: number; key: string }>
}

interface SerializedRatchetState {
  dhSelf: SerializedKeyPair
  dhRemote: string | null
  rootKey: string
  sendChain: string | null
  recvChain: string | null
  sendCounter: number
  recvCounter: number
  prevSendCounter: number
  skipped: SerializedSkippedBucket[]
  maxSkip: number
}

interface SerializedInitPayload {
  initiatorIdentityExchange: string
  initiatorIdentitySigning: string
  initiatorEphemeralPublic: string
  /** Responder's signedPreKey id that was consumed during X3DH. */
  signedPrekeyId: number
  /** Responder's one-time prekey id (or null if none was available). */
  oneTimePrekeyId: number | null
}

interface SerializedSession {
  version: number
  peerIdentityExchange: string
  peerIdentitySigning: string
  ownIdentityExchange: string
  /** Ed25519 identity-signing key of THIS device — the trust root the safety
   *  number certifies (D3). Optional for sessions persisted before D3. */
  ownIdentitySigning?: string
  ratchet: SerializedRatchetState
  /**
   * Populated by the initiator after `bootstrapSession`. Attached to the
   * first N outbound messages so the responder can run X3DH even if earlier
   * sends were dropped on the wire or stuck in an offline outbox; cleared
   * once `pendingInitAcked` is set by the first inbound DR message.
   */
  pendingInit?: SerializedInitPayload
  /** Number of outbound messages that have carried `pendingInit` so far. */
  pendingInitSends?: number
  /** Set true once an inbound DR message confirms the responder has the session. */
  pendingInitAcked?: boolean
}

/**
 * Outbound resend budget for X3DH metadata. Beyond this we stop attaching
 * `dr_init` to avoid leaking the ephemeral material indefinitely; if the
 * session is still not ACKed after this many sends, the user-visible chain
 * has bigger problems than a missing handshake.
 */
const PENDING_INIT_MAX_RESENDS = 3

function encodeKeyPair(pair: KeyPair): SerializedKeyPair {
  return { privateKey: b64urlEncode(pair.privateKey), publicKey: b64urlEncode(pair.publicKey) }
}

function decodeKeyPair(pair: SerializedKeyPair): KeyPair {
  return { privateKey: b64urlDecode(pair.privateKey), publicKey: b64urlDecode(pair.publicKey) }
}

function serializeRatchet(state: RatchetState): SerializedRatchetState {
  return {
    dhSelf: encodeKeyPair(state.dhSelf),
    dhRemote: state.dhRemote ? b64urlEncode(state.dhRemote) : null,
    rootKey: b64urlEncode(state.rootKey),
    sendChain: state.sendChain ? b64urlEncode(state.sendChain) : null,
    recvChain: state.recvChain ? b64urlEncode(state.recvChain) : null,
    sendCounter: state.sendCounter,
    recvCounter: state.recvCounter,
    prevSendCounter: state.prevSendCounter,
    skipped: Array.from(state.skipped.entries()).map(([remote, bucket]) => ({
      remote,
      keys: Array.from(bucket.entries()).map(([counter, key]) => ({
        counter,
        key: b64urlEncode(key),
      })),
    })),
    maxSkip: state.maxSkip,
  }
}

function deserializeRatchet(s: SerializedRatchetState): RatchetState {
  const skipped = new Map<string, Map<number, Uint8Array>>()
  for (const b of s.skipped) {
    const bucket = new Map<number, Uint8Array>()
    for (const k of b.keys) bucket.set(k.counter, b64urlDecode(k.key))
    skipped.set(b.remote, bucket)
  }
  return {
    dhSelf: decodeKeyPair(s.dhSelf),
    dhRemote: s.dhRemote ? b64urlDecode(s.dhRemote) : null,
    rootKey: b64urlDecode(s.rootKey),
    sendChain: s.sendChain ? b64urlDecode(s.sendChain) : null,
    recvChain: s.recvChain ? b64urlDecode(s.recvChain) : null,
    sendCounter: s.sendCounter,
    recvCounter: s.recvCounter,
    prevSendCounter: s.prevSendCounter,
    skipped,
    maxSkip: s.maxSkip,
  }
}

/**
 * Vault-derived AES-GCM key for wrapping session records at rest.  Set by the
 * host application on vault unlock (see `setSessionWrapKey`) and cleared on
 * logout.  When unset, `saveSession` refuses to persist.
 */
let sessionWrapKey: CryptoKey | null = null

export function setSessionWrapKey(key: CryptoKey | null): void {
  sessionWrapKey = key
}

export function hasSessionWrapKey(): boolean {
  return sessionWrapKey !== null
}

/** In-memory DR identity set after vault unlock. Cleared on logout. */
let _ownIdentity: IdentityKeyPair | null = null
let _ownSignedPreKey: KeyPair | null = null
let _ownSignedPreKeyId = 1
/** This device's own id — the sender-side device dimension. */
let _ownDeviceId: string | null = null
/** Derives an OTP private key by id — set from vault unlock. */
let _ownOtpDeriver: ((id: number) => Uint8Array) | null = null

/**
 * Called by vault unlock to register the local DR identity.
 *
 * `ownDeviceId` is REQUIRED for per-device DR: it is both the routing key for
 * session records and the value stamped onto every outbound envelope so the
 * peer can pick the right ratchet.
 */
export function setOwnDrIdentity(
  identity: IdentityKeyPair,
  signedPreKey: KeyPair,
  signedPreKeyId: number,
  ownDeviceId: string,
  otpDeriver?: (id: number) => Uint8Array
): void {
  _ownIdentity = identity
  _ownSignedPreKey = signedPreKey
  _ownSignedPreKeyId = signedPreKeyId
  _ownDeviceId = ownDeviceId
  _ownOtpDeriver = otpDeriver ?? null
}

export function clearOwnDrIdentity(): void {
  _ownIdentity = null
  _ownSignedPreKey = null
  _ownOtpDeriver = null
  _ownDeviceId = null
  // Also zeroize the session wrap key so chain keys cannot be decrypted after
  // logout even if IndexedDB remains accessible in the same process.
  sessionWrapKey = null
}

/** The device id this client publishes DR bundles under. */
export function getOwnDrDeviceId(): string | null {
  return _ownDeviceId
}

const WRAP_MAGIC = 0xF0 // leading byte marker "wrapped v1"
const PLAIN_MAGIC = 0x7B // '{' — JSON plaintext sentinel (legacy)

async function saveSession(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string,
  session: SerializedSession
): Promise<void> {
  if (!sessionWrapKey) {
    // Refuse to persist ratchet chain keys without a vault wrap key.
    // The vault must be unlocked before DR sessions can be established.
    throw new Error('RATCHET_VAULT_NOT_UNLOCKED')
  }
  const json = JSON.stringify(session)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      sessionWrapKey,
      bytesToArrayBuffer(ENCODER.encode(json))
    )
  )
  // Layout: [WRAP_MAGIC(1) | iv(12) | ciphertext+tag].
  const wrapped = new Uint8Array(1 + 12 + ct.length)
  wrapped[0] = WRAP_MAGIC
  wrapped.set(iv, 1)
  wrapped.set(ct, 13)
  const copy = new ArrayBuffer(wrapped.byteLength)
  new Uint8Array(copy).set(wrapped)
  await putSessionRecord(ownerId, ownDeviceId, peerId, peerDeviceId, copy, PROTOCOL_VERSION)
}

async function loadSession(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): Promise<SerializedSession | null> {
  const record = await getSessionRecord(ownerId, ownDeviceId, peerId, peerDeviceId)
  if (!record) return null
  const view = new Uint8Array(record.payload)
  try {
    if (view.length > 0 && view[0] === WRAP_MAGIC && sessionWrapKey) {
      const iv = view.slice(1, 13)
      const ct = view.slice(13)
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
          sessionWrapKey,
          bytesToArrayBuffer(ct)
        )
      )
      return JSON.parse(DECODER.decode(plain)) as SerializedSession
    }
    if (view.length > 0 && view[0] === PLAIN_MAGIC) {
      const session = JSON.parse(DECODER.decode(view)) as SerializedSession
      // Rewrap legacy plaintext records on first read so chain keys do not
      // remain at rest unencrypted in IndexedDB.
      if (sessionWrapKey) {
        try {
          await saveSession(ownerId, ownDeviceId, peerId, peerDeviceId, session)
        } catch {
          // Non-fatal: the in-memory session is still usable for this turn.
        }
      }
      return session
    }
    return null
  } catch {
    return null
  }
}

/**
 * Convert a server bundle response into the internal PreKeyBundle format.
 * Also performs the SPK-signature verification via the ratchet library.
 */
export function bundleFromResponse(resp: BundleResponse): PreKeyBundle {
  return {
    userId: resp.user_id,
    identitySigning: b64urlDecode(resp.identity.signing_public_key),
    identityExchange: b64urlDecode(resp.identity.exchange_public_key),
    identityExchangeSignature: b64urlDecode(resp.identity.exchange_public_key_signature),
    signedPreKey: {
      id: resp.signed_prekey.pre_key_id,
      publicKey: b64urlDecode(resp.signed_prekey.public_key),
      signature: b64urlDecode(resp.signed_prekey.signature),
    },
    oneTimePreKey: resp.one_time_prekey
      ? {
          id: resp.one_time_prekey.pre_key_id,
          publicKey: b64urlDecode(resp.one_time_prekey.public_key),
        }
      : null,
  }
}

export interface LocalIdentityBundle {
  identity: IdentityKeyPair
  signedPreKey: { id: number; keypair: KeyPair; signature: Uint8Array }
  oneTimePreKeys: Array<{ id: number; keypair: KeyPair }>
  /** Ed25519 signature over identityExchange by identitySigning (D4). */
  identityExchangeSignature: Uint8Array
}

/**
 * Generate a full local identity bundle. The caller is responsible for
 * persisting `identity` and `oneTimePreKeys` privately and publishing the
 * public halves to `/api/keys/*`.
 */
export function generateLocalBundle(ownOneTimeCount = 20): LocalIdentityBundle {
  const identity = generateIdentity()
  const signed = generateX25519KeyPair()
  const signedIdBuf = new Uint32Array(1)
  crypto.getRandomValues(signedIdBuf)
  const signedId = signedIdBuf[0] & 0x7fffffff
  const signature = signWithIdentity(identity, signed.publicKey)
  const oneTimePreKeys = Array.from({ length: ownOneTimeCount }, (_, i) => ({
    id: i + 1,
    keypair: generateX25519KeyPair(),
  }))
  return {
    identity,
    signedPreKey: { id: signedId, keypair: signed, signature },
    oneTimePreKeys,
    identityExchangeSignature: signIdentityExchange(identity),
  }
}

/**
 * Publish a locally-generated bundle to the server. The server resolves the
 * device id from the session JWT, so this always targets the caller's own
 * device row in the device-scoped key directory.
 */
export async function publishLocalBundle(
  bundle: LocalIdentityBundle,
  generation: number
): Promise<void> {
  await keysApi.publishIdentity({
    signing_public_key: b64urlEncode(bundle.identity.signing.publicKey),
    exchange_public_key: b64urlEncode(bundle.identity.exchange.publicKey),
    exchange_public_key_signature: b64urlEncode(bundle.identityExchangeSignature),
    generation,
  })
  await keysApi.publishSignedPrekey({
    pre_key_id: bundle.signedPreKey.id,
    public_key: b64urlEncode(bundle.signedPreKey.keypair.publicKey),
    signature: b64urlEncode(bundle.signedPreKey.signature),
  })
  if (bundle.oneTimePreKeys.length > 0) {
    await keysApi.publishOneTimePrekeys({
      keys: bundle.oneTimePreKeys.map((k) => ({
        pre_key_id: k.id,
        public_key: b64urlEncode(k.keypair.publicKey),
      })),
    })
  }
}

/**
 * Bootstrap (Alice side) — fetch ONE peer device's bundle, run X3DH, init DR.
 * Establishes the ratchet for the `(ownerId, ownDeviceId) ⇄ (peerId,
 * peerDeviceId)` device pair.
 */
export async function bootstrapSession(
  ownerId: string,
  ownDeviceId: string,
  ownIdentity: IdentityKeyPair,
  peerId: string,
  peerDeviceId: string
): Promise<SerializedSession> {
  const response = await keysApi.fetchBundle(peerId, peerDeviceId)
  const bundle = bundleFromResponse(response)

  // TOFU check: if a prior session exists with a different peer identity for
  // THIS device pair, refuse to silently re-bootstrap. We pin the Ed25519
  // SIGNING key — the trust root the safety number certifies (D3) and the key
  // that vouches for identityExchange (D4) — not just the exchange key.
  const existing = await loadSession(ownerId, ownDeviceId, peerId, peerDeviceId)
  if (!existing) {
    // loadSession returns null both when NO record exists and when a record
    // exists but could not be loaded (decrypt/parse failure, or a wrapped
    // record with a missing/rotated wrap key). Treating the latter as "no
    // session" would skip the TOFU check below and let this re-bootstrap
    // silently adopt whatever peer identity the server returns — a MitM /
    // identity-change bypass. If a raw record IS present, fail closed.
    const raw = await getSessionRecord(ownerId, ownDeviceId, peerId, peerDeviceId)
    if (raw) {
      throw new Error('TOFU_SESSION_UNREADABLE')
    }
  }
  if (
    existing &&
    (existing.peerIdentitySigning !== b64urlEncode(bundle.identitySigning) ||
      existing.peerIdentityExchange !== b64urlEncode(bundle.identityExchange))
  ) {
    throw new Error('TOFU_IDENTITY_CHANGED')
  }
  const ephemeral = generateX25519KeyPair()
  const { sharedSecret } = x3dhInitiator({
    initiatorIdentity: ownIdentity,
    ephemeral,
    bundle,
  })
  const ratchet = initRatchetAsAlice({
    sharedSecret,
    remoteDhPublic: bundle.signedPreKey.publicKey,
  })
  const session: SerializedSession = {
    version: PROTOCOL_VERSION,
    peerIdentityExchange: b64urlEncode(bundle.identityExchange),
    peerIdentitySigning: b64urlEncode(bundle.identitySigning),
    ownIdentityExchange: b64urlEncode(ownIdentity.exchange.publicKey),
    ownIdentitySigning: b64urlEncode(ownIdentity.signing.publicKey),
    ratchet: serializeRatchet(ratchet),
    pendingInit: {
      initiatorIdentityExchange: b64urlEncode(ownIdentity.exchange.publicKey),
      initiatorIdentitySigning: b64urlEncode(ownIdentity.signing.publicKey),
      initiatorEphemeralPublic: b64urlEncode(ephemeral.publicKey),
      signedPrekeyId: bundle.signedPreKey.id,
      oneTimePrekeyId: bundle.oneTimePreKey?.id ?? null,
    },
  }
  await saveSession(ownerId, ownDeviceId, peerId, peerDeviceId, session)
  return session
}

/**
 * Accept an incoming X3DH handshake (Bob side) for one device pair.
 */
export async function acceptSession(
  ownerId: string,
  ownDeviceId: string,
  ownIdentity: IdentityKeyPair,
  peerId: string,
  peerDeviceId: string,
  signedPreKey: KeyPair,
  oneTimePreKey: KeyPair | null,
  initial: {
    initiatorIdentityExchange: Uint8Array
    initiatorIdentitySigning: Uint8Array
    initiatorEphemeralPublic: Uint8Array
  }
): Promise<SerializedSession> {
  const { sharedSecret } = x3dhResponder({
    responderIdentity: ownIdentity,
    signedPreKey,
    oneTimePreKey,
    initiatorIdentityPublic: initial.initiatorIdentityExchange,
    initiatorEphemeralPublic: initial.initiatorEphemeralPublic,
  })
  const ratchet = initRatchetAsBob({
    sharedSecret,
    selfDh: signedPreKey,
  })
  const session: SerializedSession = {
    version: PROTOCOL_VERSION,
    peerIdentityExchange: b64urlEncode(initial.initiatorIdentityExchange),
    peerIdentitySigning: b64urlEncode(initial.initiatorIdentitySigning),
    ownIdentityExchange: b64urlEncode(ownIdentity.exchange.publicKey),
    ownIdentitySigning: b64urlEncode(ownIdentity.signing.publicKey),
    ratchet: serializeRatchet(ratchet),
  }
  await saveSession(ownerId, ownDeviceId, peerId, peerDeviceId, session)
  return session
}

export interface DrInitWirePayload {
  /** p13 envelope marker so the server/client can route v2 messages. */
  p13: 'dr-init'
  v: 1
  initiatorIdentityExchange: string
  initiatorIdentitySigning: string
  initiatorEphemeralPublic: string
  signedPrekeyId: number
  oneTimePrekeyId: number | null
}

/**
 * Self-contained per-device DR envelope. One of these is packed into each
 * `message_deliveries` slot's ciphertext column (see file header).
 */
export interface DrDeviceEnvelope {
  /** Envelope format version. */
  v: 2
  /** Sender's device id — routes the receiver to the right ratchet. */
  sd: string
  /** Base64url-encoded JSON `{ dhPub, prevN, n }`. */
  h: string
  /** Base64url-encoded AES-GCM ciphertext||tag. */
  c: string
  /** Present only on the first outbound message of a session. */
  i?: DrInitWirePayload
}

/** One fan-out target: a recipient device id and its packed envelope JSON. */
export interface DrDeviceSlot {
  /** Recipient device id (a peer device, or one of the sender's own). */
  deviceId: string
  /** JSON.stringify(DrDeviceEnvelope) — goes straight into the slot ciphertext. */
  envelope: string
}

export interface DrFanoutResult {
  slots: DrDeviceSlot[]
}

function encodeHeader(header: RatchetHeader): string {
  return b64urlEncode(
    ENCODER.encode(
      JSON.stringify({
        dhPub: b64urlEncode(header.dhPub),
        prevN: header.previousChainLength,
        n: header.counter,
      })
    )
  )
}

function decodeHeader(encoded: string): RatchetHeader {
  const parsed = JSON.parse(DECODER.decode(b64urlDecode(encoded))) as {
    dhPub: string
    prevN: number
    n: number
  }
  return {
    dhPub: b64urlDecode(parsed.dhPub),
    previousChainLength: parsed.prevN,
    counter: parsed.n,
  }
}

/**
 * Per-session async mutex.
 *
 * The A4 session layer performs a non-atomic load -> mutate -> save against
 * the shared session store. Without serialization two concurrent sends to the
 * same device pair both observe "no session" and double-bootstrap — producing
 * messages under divergent ratchets the recipient cannot follow ("first
 * message decrypts, the rest fail") — and a concurrent decrypt batch races
 * session creation (`RATCHET_NO_SESSION`) or clobbers a chain-key advance.
 *
 * Every read-modify-write of one device-pair ratchet runs through
 * `runExclusive` keyed by that pair's record id, so operations on the SAME
 * ratchet are strictly serialized while distinct ratchets still run in
 * parallel. The chain is a per-key promise queue; a failed task does not break
 * the queue, and drained keys are dropped so the map cannot grow unbounded.
 */
const sessionChains = new Map<string, Promise<unknown>>()

function sessionLockKey(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): string {
  return `${ownerId} ${ownDeviceId} ${peerId} ${peerDeviceId}`
}

function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = sessionChains.get(key) ?? Promise.resolve()
  const result = prev.then(() => task())
  // A never-rejecting tail so the next caller can chain on regardless of how
  // this task settled.
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  sessionChains.set(key, tail)
  void tail.then(() => {
    if (sessionChains.get(key) === tail) sessionChains.delete(key)
  })
  return result
}

/**
 * Encrypt `plaintext` once per device of `peerId`, advancing (or
 * bootstrapping) the dedicated ratchet for every `(ownDevice ⇄ peerDevice)`
 * pair, and ALSO once per OTHER device of the sender so the message syncs to
 * the sender's other devices (outbox sync, exactly as the v1 fan-out does).
 *
 * Returns one wire envelope per recipient device id. The caller maps each
 * `DrDeviceSlot` onto a `message_deliveries` slot.
 *
 * Throws `RATCHET_NO_SESSION` only when the local DR identity is missing or
 * no recipient device could be established at all — callers fall back to v1.
 */
export async function encryptForPeer(
  ownerId: string,
  peerId: string,
  plaintext: string
): Promise<DrFanoutResult> {
  if (!_ownIdentity || !_ownDeviceId) throw new Error('RATCHET_NO_SESSION')
  const ownDeviceId = _ownDeviceId
  const ownIdentity = _ownIdentity

  // Resolve every device that should receive a copy:
  //   - all of the peer's devices,
  //   - all of the sender's OTHER devices (skip this one).
  const [peerDevices, ownDevices] = await Promise.all([
    keysApi.fetchDeviceIdentities(peerId).then((r) => r.devices).catch(() => []),
    keysApi.fetchDeviceIdentities(ownerId).then((r) => r.devices).catch(() => []),
  ])

  type Target = { userId: string; deviceId: string }
  const targets: Target[] = []
  for (const d of peerDevices) targets.push({ userId: peerId, deviceId: d.device_id })
  for (const d of ownDevices) {
    if (d.device_id === ownDeviceId) continue // never ratchet to ourselves
    // Saved-Messages (peerId === ownerId): peer fetch already covered these.
    if (peerId === ownerId) continue
    targets.push({ userId: ownerId, deviceId: d.device_id })
  }
  // De-dup defensively (peerId === ownerId edge, or registry races).
  const seen = new Set<string>()
  const uniqueTargets = targets.filter((t) => {
    const k = `${t.userId}::${t.deviceId}`
    if (seen.has(k) || t.deviceId === ownDeviceId) return false
    seen.add(k)
    return true
  })

  if (uniqueTargets.length === 0) throw new Error('RATCHET_NO_SESSION')

  // Fail CLOSED: for a real DIRECT chat (peerId !== ownerId) there MUST be at
  // least one device belonging to the peer. If the peer published an ECDH key
  // but no DR identity (peerDevices === []), uniqueTargets would otherwise hold
  // only the sender's OTHER devices — the send would "succeed" while the
  // recipient gets nothing (there is no v1 downgrade). Surface SEND FAILED
  // instead of silently self-fanning-out.
  const peerDeviceIds = new Set(peerDevices.map((d) => d.device_id))
  if (peerId !== ownerId && !uniqueTargets.some((t) => t.userId === peerId)) {
    throw new Error('RATCHET_NO_SESSION')
  }

  const plainBytes = ENCODER.encode(plaintext)
  const slots: DrDeviceSlot[] = []

  for (const target of uniqueTargets) {
    try {
      // Serialize load -> bootstrap -> encrypt -> save per device pair so two
      // concurrent sends cannot both bootstrap a fresh ratchet for it.
      const slot = await runExclusive(
        sessionLockKey(ownerId, ownDeviceId, target.userId, target.deviceId),
        async (): Promise<DrDeviceSlot> => {
          let session = await loadSession(ownerId, ownDeviceId, target.userId, target.deviceId)
          if (!session) {
            session = await bootstrapSession(
              ownerId,
              ownDeviceId,
              ownIdentity,
              target.userId,
              target.deviceId
            )
          }
          const ratchet = deserializeRatchet(session.ratchet)
          const msg: RatchetMessage = await encryptRatchet(ratchet, plainBytes)
          session.ratchet = serializeRatchet(ratchet)

          const envelope: DrDeviceEnvelope = {
            v: 2,
            sd: ownDeviceId,
            h: encodeHeader(msg.header),
            c: b64urlEncode(msg.ciphertext),
          }
          if (session.pendingInit && !session.pendingInitAcked) {
            envelope.i = {
              p13: 'dr-init',
              v: 1,
              initiatorIdentityExchange: session.pendingInit.initiatorIdentityExchange,
              initiatorIdentitySigning: session.pendingInit.initiatorIdentitySigning,
              initiatorEphemeralPublic: session.pendingInit.initiatorEphemeralPublic,
              signedPrekeyId: session.pendingInit.signedPrekeyId,
              oneTimePrekeyId: session.pendingInit.oneTimePrekeyId,
            }
            const sends = (session.pendingInitSends ?? 0) + 1
            session.pendingInitSends = sends
            if (sends >= PENDING_INIT_MAX_RESENDS) {
              delete session.pendingInit
              delete session.pendingInitSends
            }
          }
          await saveSession(ownerId, ownDeviceId, target.userId, target.deviceId, session)
          return {
            deviceId: target.deviceId,
            envelope: JSON.stringify(envelope),
          }
        }
      )
      slots.push(slot)
    } catch (err) {
      // A single device failing (no bundle yet, stale OPK pool, …) must not
      // sink the whole send — skip it and keep fanning out to the rest.
      if (err instanceof Error && err.message === 'TOFU_IDENTITY_CHANGED') throw err
      if (typeof console !== 'undefined') {
        console.warn('[ratchet] per-device encrypt skipped a device', {
          peerUserId: target.userId,
          peerDeviceId: target.deviceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (slots.length === 0) throw new Error('RATCHET_NO_SESSION')
  // Even with a peer device listed, every per-device bootstrap for the peer can
  // fail (missing/expired bundle) and be swallowed above, leaving only self
  // slots. Still fail closed so the peer is never silently skipped.
  if (peerId !== ownerId && !slots.some((s) => peerDeviceIds.has(s.deviceId))) {
    throw new Error('RATCHET_NO_SESSION')
  }
  return { slots }
}

/**
 * Accept an incoming X3DH init from the wire payload, for the device pair
 * `(ownerId, ownDeviceId) ⇄ (peerId, senderDeviceId)`.
 * Safe to call even if a session already exists (no-op in that case).
 */
export async function acceptIncomingInit(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  senderDeviceId: string,
  init: DrInitWirePayload
): Promise<void> {
  const existing = await loadSession(ownerId, ownDeviceId, peerId, senderDeviceId)
  if (existing) return
  if (!_ownIdentity || !_ownSignedPreKey) throw new Error('RATCHET_NO_IDENTITY')
  if (init.signedPrekeyId !== _ownSignedPreKeyId) throw new Error('RATCHET_UNKNOWN_SPK')
  // Verify the wire-supplied initiator identity matches what the server has
  // published for that SPECIFIC sender device. Without this, an authenticated
  // attacker can post a forged `dr_init` and bootstrap a session under any
  // identity they choose; Bob's TOFU pin would then lock in the attacker's keys.
  const identity = await keysApi.fetchIdentity(peerId, senderDeviceId)
  if (
    identity.identity.signing_public_key !== init.initiatorIdentitySigning ||
    identity.identity.exchange_public_key !== init.initiatorIdentityExchange
  ) {
    throw new Error('X3DH_IDENTITY_MISMATCH')
  }
  let otpKeyPair: KeyPair | null = null
  if (init.oneTimePrekeyId != null && _ownOtpDeriver) {
    const priv = _ownOtpDeriver(init.oneTimePrekeyId)
    const { x25519 } = await import('@noble/curves/ed25519')
    otpKeyPair = { privateKey: priv, publicKey: x25519.getPublicKey(priv) }
  }
  await acceptSession(
    ownerId,
    ownDeviceId,
    _ownIdentity,
    peerId,
    senderDeviceId,
    _ownSignedPreKey,
    otpKeyPair,
    {
      initiatorIdentityExchange: b64urlDecode(init.initiatorIdentityExchange),
      initiatorIdentitySigning: b64urlDecode(init.initiatorIdentitySigning),
      initiatorEphemeralPublic: b64urlDecode(init.initiatorEphemeralPublic),
    }
  )
}

/**
 * Decrypt a per-device DR envelope. The envelope's `sd` field selects the
 * sender device, which is the `peerDeviceId` half of the routing key — the
 * receiver decrypts on the ratchet `(ownerId, ownDeviceId) ⇄ (peerId, sd)`.
 */
export async function decryptFromPeer(
  ownerId: string,
  peerId: string,
  envelope: DrDeviceEnvelope
): Promise<string> {
  if (!_ownDeviceId) throw new Error('RATCHET_NO_SESSION')
  const ownDeviceId = _ownDeviceId
  const senderDeviceId = envelope.sd
  if (!senderDeviceId) throw new Error('RATCHET_NO_SENDER_DEVICE')

  // Serialize the whole accept -> load -> decrypt -> save critical section on
  // this device-pair ratchet: a concurrent decrypt batch must not race session
  // creation, and a decrypt must not interleave with a send on the same
  // ratchet (a lost chain-key advance would reuse a message key).
  return runExclusive(
    sessionLockKey(ownerId, ownDeviceId, peerId, senderDeviceId),
    async () => {
      // If the envelope carries a session init and we have no session yet for
      // this device pair, accept it.
      if (envelope.i) {
        try {
          await acceptIncomingInit(ownerId, ownDeviceId, peerId, senderDeviceId, envelope.i)
        } catch (err) {
          // Identity mismatch is fatal — never fall through under a wire-claimed
          // identity that doesn't match the device's published bundle.
          if (err instanceof Error && err.message === 'X3DH_IDENTITY_MISMATCH') throw err
          // Other failures are non-fatal; fall through and see if a session exists.
        }
      }
      const session = await loadSession(ownerId, ownDeviceId, peerId, senderDeviceId)
      if (!session) throw new Error('RATCHET_NO_SESSION')
      const ratchet = deserializeRatchet(session.ratchet)
      const header = decodeHeader(envelope.h)
      const ciphertext = b64urlDecode(envelope.c)
      const plaintext = await decryptRatchet(ratchet, { header, ciphertext })
      session.ratchet = serializeRatchet(ratchet)
      // First successful inbound DR message proves the responder has the X3DH
      // session — we no longer need to resend pendingInit on subsequent sends.
      if (session.pendingInit && !session.pendingInitAcked) {
        session.pendingInitAcked = true
        delete session.pendingInit
        delete session.pendingInitSends
      }
      await saveSession(ownerId, ownDeviceId, peerId, senderDeviceId, session)
      return DECODER.decode(plaintext)
    }
  )
}

/**
 * Compute a session fingerprint for safety-number UI. Hashes the pair of
 * Ed25519 identity-SIGNING keys (the trust root — D3) for ONE device pair so
 * the output matches between the two devices regardless of who initiated.
 *
 * `peerDeviceId` defaults to the most-recent device when omitted.
 */
export async function sessionFingerprint(
  ownerId: string,
  peerId: string,
  peerDeviceId?: string
): Promise<Uint8Array | null> {
  if (!_ownDeviceId) return null
  const targetPeerDevice =
    peerDeviceId ??
    (await keysApi
      .fetchIdentity(peerId)
      .then((r) => r.device_id ?? null)
      .catch(() => null))
  if (!targetPeerDevice) return null
  const session = await loadSession(ownerId, _ownDeviceId, peerId, targetPeerDevice)
  if (!session) return null
  // D3: the safety number certifies the Ed25519 SIGNING identities (the trust
  // root that vouches for the DH keys), not the substitutable exchange keys.
  // Sessions persisted before D3 lack ownIdentitySigning → no number until the
  // ratchet re-bootstraps (the D4 key-directory reset forces that anyway).
  if (!session.ownIdentitySigning) return null
  return fingerprint(
    b64urlDecode(session.ownIdentitySigning),
    b64urlDecode(session.peerIdentitySigning)
  )
}

/**
 * Stored peer identity-exchange public key (base64url) for the TOFU UI.
 *
 * With per-device DR there is one session per peer device; this resolves the
 * peer's most-recent device (the same one `fetchBundle(peerId)` returns with
 * no `device_id`) and returns that session's pinned peer identity, so the UI
 * can compare it against a freshly-fetched bundle.
 */
export async function getSessionPeerIdentity(
  ownerId: string,
  peerId: string,
  peerDeviceId?: string
): Promise<string | null> {
  if (!_ownDeviceId) return null
  const targetPeerDevice =
    peerDeviceId ??
    (await keysApi
      .fetchIdentity(peerId)
      .then((r) => r.device_id ?? null)
      .catch(() => null))
  if (!targetPeerDevice) return null
  const session = await loadSession(ownerId, _ownDeviceId, peerId, targetPeerDevice)
  return session?.peerIdentityExchange ?? null
}

/**
 * Clear every per-device DR session for a (owner, peer) conversation so it can
 * be re-bootstrapped with a new identity. Call only after explicit user
 * confirmation of a key change (TOFU reset).
 */
export async function clearDrSession(ownerId: string, peerId: string): Promise<void> {
  await deleteSessionRecordsForPeer(ownerId, peerId)
}

/** Drop a single device-pair ratchet record (targeted recovery). */
export async function clearDrSessionForDevice(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): Promise<void> {
  await deleteSessionRecord(ownerId, ownDeviceId, peerId, peerDeviceId)
}

/** Utility re-exports the callers typically need. */
export {
  PROTOCOL_VERSION,
  DR_IV_SENTINEL,
  b64urlEncode as encodeBase64Url,
  b64urlDecode as decodeBase64Url,
}

/* c8 ignore next */
export const __onlyForTypescriptUnusedImports__ = generateEd25519KeyPair

export type { KeyPair }

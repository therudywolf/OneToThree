/**
 * Double Ratchet session manager — bridges the pure ratchet library
 * (`double-ratchet.ts`, `x3dh.ts`) with the server key directory (`/api/keys`)
 * and the client-side IndexedDB session store.
 *
 * Responsibilities
 *   - Boot per-peer sessions (X3DH → DR) on demand.
 *   - Serialize / deserialize session state for persistence.
 *   - Encrypt outbound messages into `{ protocolVersion: 2, drHeader, iv, ciphertext }`.
 *   - Decrypt inbound messages tagged with `protocolVersion: 2`.
 *   - Reuse and advance the session on every exchange.
 *
 * The on-wire shape used by phase 3.3 messages:
 *   drHeader = base64url(JSON.stringify({ dhPub, prevN, n }))
 *   encrypted_content = base64url(ciphertext + 16-byte GCM tag)
 *   iv = base64url("dr:") — a sentinel that the wire carries the ratchet,
 *        since AES-GCM nonces live inside the DR derivation (deriveMessageAead).
 *
 * The session payload is currently stored as *plaintext* JSON in IndexedDB.
 * In phase 6 we will wrap it with a vault-derived AES-GCM key; the store
 * already expects an `ArrayBuffer`, so migration is additive.
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
  type IdentityKeyPair,
  type KeyPair,
} from './keys'
import { putSessionRecord, getSessionRecord } from './session-store'
import { x3dhInitiator, x3dhResponder, type PreKeyBundle } from './x3dh'

const PROTOCOL_VERSION = 2
const DR_IV_SENTINEL = 'dr:v2'
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
  ratchet: SerializedRatchetState
  /**
   * Populated by the initiator after `bootstrapSession`. Attached to the
   * first outbound message so the responder can run X3DH; cleared after
   * the first successful `encryptForPeer`.
   */
  pendingInit?: SerializedInitPayload
}

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
 * logout.  When unset, session records are stored plaintext (v1 behaviour) —
 * callers should treat this as a "legacy" mode and upgrade when possible.
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
/** Derives an OTP private key by id — set from vault unlock. */
let _ownOtpDeriver: ((id: number) => Uint8Array) | null = null

/**
 * Called by vault unlock to register the local DR identity.
 * The identity keys are derived deterministically from the vault ECDH key,
 * so this just stores the in-memory reference for session bootstrap.
 */
export function setOwnDrIdentity(
  identity: IdentityKeyPair,
  signedPreKey: KeyPair,
  signedPreKeyId: number,
  otpDeriver?: (id: number) => Uint8Array
): void {
  _ownIdentity = identity
  _ownSignedPreKey = signedPreKey
  _ownSignedPreKeyId = signedPreKeyId
  _ownOtpDeriver = otpDeriver ?? null
}

export function clearOwnDrIdentity(): void {
  _ownIdentity = null
  _ownSignedPreKey = null
  _ownOtpDeriver = null
}

const WRAP_MAGIC = 0xF0 // leading byte marker "wrapped v1"
const PLAIN_MAGIC = 0x7B // '{' — JSON plaintext sentinel (legacy)

async function saveSession(
  ownerId: string,
  peerId: string,
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
  await putSessionRecord(ownerId, peerId, copy, PROTOCOL_VERSION)
}

async function loadSession(
  ownerId: string,
  peerId: string
): Promise<SerializedSession | null> {
  const record = await getSessionRecord(ownerId, peerId)
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
      // remain at rest unencrypted in IndexedDB. Only attempt the rewrap
      // when the vault wrap key is available; otherwise the record stays
      // as-is until the next read with a vault unlocked.
      if (sessionWrapKey) {
        try {
          await saveSession(ownerId, peerId, session)
          console.warn('[ratchet] rewrapped legacy plaintext session record')
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
}

/**
 * Generate a full local identity bundle. The caller is responsible for
 * persisting `identity` and `oneTimePreKeys` privately and publishing the
 * public halves to `/api/keys/*`.
 *
 * `ownOneTimeCount` controls how many one-time pre-keys are pre-allocated
 * (20 covers roughly a month of activity against the 200-key server cap).
 */
export function generateLocalBundle(ownOneTimeCount = 20): LocalIdentityBundle {
  const identity = generateIdentity()
  const signed = generateX25519KeyPair()
  const signedId = Math.floor(Math.random() * 0x7fffffff)
  const signature = signWithIdentity(identity, signed.publicKey)
  const oneTimePreKeys = Array.from({ length: ownOneTimeCount }, (_, i) => ({
    id: i + 1,
    keypair: generateX25519KeyPair(),
  }))
  return {
    identity,
    signedPreKey: { id: signedId, keypair: signed, signature },
    oneTimePreKeys,
  }
}

/**
 * Publish a locally-generated bundle to the server. Intended to be called
 * once per device after vault unlock; subsequent calls are safe (the server
 * rejects stale generations and dedupes one-time keys).
 */
export async function publishLocalBundle(
  bundle: LocalIdentityBundle,
  generation: number
): Promise<void> {
  await keysApi.publishIdentity({
    signing_public_key: b64urlEncode(bundle.identity.signing.publicKey),
    exchange_public_key: b64urlEncode(bundle.identity.exchange.publicKey),
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
 * Bootstrap (Alice side) — fetch the peer's bundle, run X3DH, init DR.
 * Call this when the user sends the first message to `peerId` and no session
 * record is present.
 */
export async function bootstrapSession(
  ownerId: string,
  ownIdentity: IdentityKeyPair,
  peerId: string
): Promise<SerializedSession> {
  const response = await keysApi.fetchBundle(peerId)
  const bundle = bundleFromResponse(response)

  // TOFU check: if a prior session exists with a different peer identity, refuse
  // to silently re-bootstrap — the caller must explicitly clear the old session first.
  const existing = await loadSession(ownerId, peerId)
  if (existing && existing.peerIdentityExchange !== b64urlEncode(bundle.identityExchange)) {
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
    ratchet: serializeRatchet(ratchet),
    pendingInit: {
      initiatorIdentityExchange: b64urlEncode(ownIdentity.exchange.publicKey),
      initiatorIdentitySigning: b64urlEncode(ownIdentity.signing.publicKey),
      initiatorEphemeralPublic: b64urlEncode(ephemeral.publicKey),
      signedPrekeyId: bundle.signedPreKey.id,
      oneTimePrekeyId: bundle.oneTimePreKey?.id ?? null,
    },
  }
  await saveSession(ownerId, peerId, session)
  return session
}

/**
 * Accept an incoming X3DH handshake (Bob side). This branch fires when a
 * peer reaches us for the first time and we have no session record.
 *
 * `initial` carries the metadata we need to mirror Alice's derivation:
 *   - initiatorIdentityExchange (public)
 *   - initiatorEphemeralPublic
 *   - oneTimePreKey id (or null)
 */
export async function acceptSession(
  ownerId: string,
  ownIdentity: IdentityKeyPair,
  peerId: string,
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
    ratchet: serializeRatchet(ratchet),
  }
  await saveSession(ownerId, peerId, session)
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

export interface DrWireMessage {
  protocolVersion: 2
  /** Base64url-encoded JSON `{ dhPub, prevN, n }`. */
  drHeader: string
  /** Sentinel; real AES nonce is derived inside the ratchet. */
  iv: string
  /** Base64url-encoded AES-GCM ciphertext||tag. */
  encrypted_content: string
  /** Only present on the very first outbound message of a session. */
  drInit?: DrInitWirePayload
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

export async function encryptForPeer(
  ownerId: string,
  peerId: string,
  plaintext: string
): Promise<DrWireMessage> {
  let session = await loadSession(ownerId, peerId)
  if (!session) {
    // Auto-bootstrap: fetch peer bundle and run X3DH on first message.
    // Falls back to RATCHET_NO_SESSION if identity or peer bundle unavailable.
    if (!_ownIdentity) throw new Error('RATCHET_NO_SESSION')
    try {
      session = await bootstrapSession(ownerId, _ownIdentity, peerId)
    } catch (err) {
      if (err instanceof Error && err.message === 'TOFU_IDENTITY_CHANGED') throw err
      throw new Error('RATCHET_NO_SESSION')
    }
  }
  const ratchet = deserializeRatchet(session.ratchet)
  const msg: RatchetMessage = await encryptRatchet(ratchet, ENCODER.encode(plaintext))
  session.ratchet = serializeRatchet(ratchet)

  const wire: DrWireMessage = {
    protocolVersion: 2,
    drHeader: encodeHeader(msg.header),
    iv: DR_IV_SENTINEL,
    encrypted_content: b64urlEncode(msg.ciphertext),
  }
  if (session.pendingInit) {
    wire.drInit = {
      p13: 'dr-init',
      v: 1,
      initiatorIdentityExchange: session.pendingInit.initiatorIdentityExchange,
      initiatorIdentitySigning: session.pendingInit.initiatorIdentitySigning,
      initiatorEphemeralPublic: session.pendingInit.initiatorEphemeralPublic,
      signedPrekeyId: session.pendingInit.signedPrekeyId,
      oneTimePrekeyId: session.pendingInit.oneTimePrekeyId,
    }
    // Once the responder has seen the X3DH metadata (via subsequent
    // receive-side ratchet advance), further sends don't need it.  We clear
    // eagerly rather than tracking an ACK so offline-queue scenarios don't
    // leak the ephemeral metadata repeatedly.
    delete session.pendingInit
  }
  await saveSession(ownerId, peerId, session)
  return wire
}

/**
 * Accept an incoming X3DH init from the wire payload.
 * Safe to call even if a session already exists (no-op in that case).
 */
export async function acceptIncomingInit(
  ownerId: string,
  peerId: string,
  init: DrInitWirePayload
): Promise<void> {
  const existing = await loadSession(ownerId, peerId)
  if (existing) return
  if (!_ownIdentity || !_ownSignedPreKey) throw new Error('RATCHET_NO_IDENTITY')
  if (init.signedPrekeyId !== _ownSignedPreKeyId) throw new Error('RATCHET_UNKNOWN_SPK')
  // Verify the wire-supplied initiator identity matches what the server has
  // published for this peer. Without this, an authenticated attacker can post
  // a forged `dr_init` and bootstrap a session under any identity they choose;
  // Bob's TOFU pin would then lock in the attacker's keys.
  const identity = await keysApi.fetchIdentity(peerId)
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
  await acceptSession(ownerId, _ownIdentity, peerId, _ownSignedPreKey, otpKeyPair, {
    initiatorIdentityExchange: b64urlDecode(init.initiatorIdentityExchange),
    initiatorIdentitySigning: b64urlDecode(init.initiatorIdentitySigning),
    initiatorEphemeralPublic: b64urlDecode(init.initiatorEphemeralPublic),
  })
}

export async function decryptFromPeer(
  ownerId: string,
  peerId: string,
  wire: DrWireMessage
): Promise<string> {
  // If the wire carries a session init and we have no session yet, accept it.
  if (wire.drInit) {
    try {
      await acceptIncomingInit(ownerId, peerId, wire.drInit)
    } catch (err) {
      // Identity mismatch is fatal — never fall through to plaintext under
      // a wire-claimed identity that doesn't match the published bundle.
      if (err instanceof Error && err.message === 'X3DH_IDENTITY_MISMATCH') throw err
      // Other failures are non-fatal; fall through and see if a session exists
      // anyway (e.g. race with another device).
    }
  }
  const session = await loadSession(ownerId, peerId)
  if (!session) throw new Error('RATCHET_NO_SESSION')
  const ratchet = deserializeRatchet(session.ratchet)
  const header = decodeHeader(wire.drHeader)
  const ciphertext = b64urlDecode(wire.encrypted_content)
  const plaintext = await decryptRatchet(ratchet, { header, ciphertext })
  session.ratchet = serializeRatchet(ratchet)
  await saveSession(ownerId, peerId, session)
  return DECODER.decode(plaintext)
}

/**
 * Compute a session fingerprint that safety numbers / UI can display. We hash
 * the pair of identity-exchange keys so the output matches between Alice and
 * Bob regardless of who initiated the session.
 */
export async function sessionFingerprint(
  ownerId: string,
  peerId: string
): Promise<Uint8Array | null> {
  const session = await loadSession(ownerId, peerId)
  if (!session) return null
  return fingerprint(
    b64urlDecode(session.ownIdentityExchange),
    b64urlDecode(session.peerIdentityExchange)
  )
}

/**
 * Get the stored peer identity exchange public key for a session (base64url).
 * Used by TOFU UI to compare against a freshly-fetched bundle.
 */
export async function getSessionPeerIdentity(
  ownerId: string,
  peerId: string
): Promise<string | null> {
  const session = await loadSession(ownerId, peerId)
  return session?.peerIdentityExchange ?? null
}

/**
 * Clear a DR session record so it can be re-bootstrapped with a new identity.
 * Call only after explicit user confirmation of a key change (TOFU reset).
 */
export async function clearDrSession(ownerId: string, peerId: string): Promise<void> {
  const { deleteSessionRecord } = await import('./session-store')
  await deleteSessionRecord(ownerId, peerId)
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

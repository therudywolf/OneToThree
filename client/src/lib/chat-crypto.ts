// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  hashPublicKeyJwk,
  importEcdhPublicKey,
} from './crypto'
import { readStoredSectorKeyEpoch, unwrapGroupKeyFromStoredPayload } from './chat-logic'
import { setSectorMediaRing } from './sector-media-ring'
import { addRingEntry, getRingEntries } from './sector-keyring'

/**
 * PROJECT 13 :: ENCRYPTION_FRAME_PROTOCOL
 * Level: Connection Layer (E2E Logic)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export type ChatCryptoContext =
  | { mode: 'DIRECT'; peerPublicKeyJwk: string }
  /**
   * SELF mode: Saved Messages / self-chat (one member = me). We key off
   * our OWN public JWK — ECDH(priv, pub) gives a deterministic secret that
   * only we can reproduce but is fully self-contained (no peer required).
   */
  | { mode: 'SELF'; selfPublicKeyJwk: string }
  | {
      mode: 'SECTOR'
      /**
       * The chat this frame was built for. `useChatCryptoContext` keeps the
       * PREVIOUS chat's context in state while the new one is being fetched, so
       * a consumer that reads `groupKey` on an `activeChatId` change can be
       * handed the wrong group's key — the owner's key-distribution scan did
       * exactly that and PUT group A's key into group B's roster, permanently
       * locking that member out of B. Consumers MUST check this against the id
       * they are acting on before touching `groupKey`.
       */
      chatId: string
      /** Current (highest-epoch) key — used to ENCRYPT and tried FIRST on
       *  decrypt, so current traffic is byte-identical to the pre-#32 path. */
      groupKey: CryptoKey
      /** #32/#33 per-epoch key ring, newest epoch first, `groupKey` at [0].
       *  Decrypt tries these in order so messages sealed under prior epochs
       *  still open after a rotation. Absent → treat as `[groupKey]`. */
      groupKeyRing?: CryptoKey[]
    }
  | { mode: 'PUBLIC' }

type SectorDetailResponse = {
  chat: { type: string }
  members: Array<{
    user_id: string
    ecdh_public_key_jwk: string | null
    encrypted_group_key: string | null
    role?: 'owner' | 'admin' | 'member'
  }>
}

/**
 * [TRUST_VERIFICATION] :: Проверка отпечатка в локальном реестре доверия.
 * Бросает исключение при несовпадении закреплённого и полученного ключа,
 * а также если реестр доверия повреждён (fail-closed — повреждённый реестр
 * никогда не должен молча «расцеплять» все pin'ы).
 *
 * The registry stores exactly ONE representation: the SHA-256 hex digest that
 * `hashPublicKeyJwk` produces, which is the only thing `setVerifiedHash` is ever
 * called with (identity-modal.tsx). This function used to compare that digest
 * against the RAW roster JWK, which can never be equal — so verifying a peer
 * threw SECURITY_SIGNAL_MISMATCH for that peer's honest, unchanged key and
 * bricked the chat (and its forward/media path) until the user un-verified.
 * Pinning therefore protected nobody: it was inert for unpinned peers and fatal
 * for pinned ones. Hash the received key the same way the pin was minted and
 * compare digests.
 *
 * Named `assertTrustOrThrow` to make the throwing contract explicit at call
 * sites. Both `buildChatCryptoContext` and `buildChatCryptoContextWithMeta`
 * must call this so that neither the primary path nor the meta/forward path
 * can bypass trust verification.
 */
export async function assertTrustOrThrow(peerUserId: string, receivedJwk: string): Promise<void> {
  const registryRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('p13_trust_registry') : null
  if (!registryRaw) return

  let registry: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(registryRaw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not-an-object')
    registry = parsed as Record<string, unknown>
  } catch {
    // A corrupt trust registry must FAIL CLOSED: silently treating every
    // pinned peer as unpinned would let a key substitution slip through
    // unnoticed — the exact attack pinning exists to stop.
    throw new Error('SECURITY_SIGNAL_REGISTRY_CORRUPT :: COMPROMISED_LINK')
  }

  const pinnedSignal = registry[peerUserId]
  if (!pinnedSignal) return
  if (typeof pinnedSignal !== 'string') {
    // A non-string pin cannot have come from `setVerifiedHash` → treat it as
    // tampering rather than as "no pin".
    throw new Error('SECURITY_SIGNAL_MISMATCH :: COMPROMISED_LINK')
  }

  let receivedHash: string
  try {
    receivedHash = await hashPublicKeyJwk(JSON.parse(receivedJwk) as JsonWebKey)
  } catch {
    // An unparseable roster key can never be proven equal to a pin.
    throw new Error('SECURITY_SIGNAL_MISMATCH :: COMPROMISED_LINK')
  }
  if (pinnedSignal !== receivedHash) {
    throw new Error('SECURITY_SIGNAL_MISMATCH :: COMPROMISED_LINK')
  }
}

/**
 * [RESOLVE_SECTOR_OWNER] :: Locate the chat OWNER's ECDH public key from the
 * member roster, for binding the SECTOR group-key wrap (D2). The owner is the
 * single party allowed to mint/distribute the group key, so a member must only
 * ever adopt a wrapped key sealed under the OWNER's identity — never an admin's
 * or a server-substituted key. Fails closed: a SECTOR chat with no resolvable
 * owner key cannot be keyed (an attacker must not be able to suppress the owner
 * row to bypass the binding).
 */
function resolveSectorOwnerEcdhJwk(members: SectorDetailResponse['members']): string {
  const owner = members.find((m) => m.role === 'owner')
  if (!owner?.ecdh_public_key_jwk) {
    throw new Error('ERR_MISSING_SECTOR_OWNER_SIGNAL')
  }
  return owner.ecdh_public_key_jwk
}

/**
 * [BUILD_SECTOR_FRAME] :: Assemble the SECTOR crypto frame with its per-epoch
 * key ring (#32/#33). Shared by both context builders so the primary and the
 * forward/media path key groups identically.
 *
 * `groupKey` is the CURRENT (highest-epoch) key — used to encrypt and tried
 * first on decrypt. `groupKeyRing` prepends it, then appends every retained
 * older-epoch key so post-rotation history still decrypts for existing members.
 * A newly added member has only the current epoch in its ring (older blobs were
 * sealed to the OTHER members and were never delivered to it), so it cannot read
 * pre-join history — backward secrecy (#32). Ring assembly is best-effort: an
 * old blob that fails to unwrap (e.g. sealed by a since-replaced owner) is
 * skipped, never fatal; the current key always leads the ring.
 */
async function buildSectorFrame(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey,
  members: SectorDetailResponse['members']
): Promise<Extract<ChatCryptoContext, { mode: 'SECTOR' }>> {
  const me = members.find((m) => m.user_id === myUserId)
  if (!me?.encrypted_group_key) throw new Error('ERR_MISSING_SECTOR_KEY')

  // D2: bind the wrap to the OWNER's pinned ECDH key so a server- or
  // admin-substituted key is rejected (fail-closed) rather than silently
  // adopted, which would hand the attacker full group read/inject.
  const ownerEcdhJwk = resolveSectorOwnerEcdhJwk(members)
  const currentKey = await unwrapGroupKeyFromStoredPayload(
    privateKey,
    me.encrypted_group_key,
    ownerEcdhJwk,
    { chatId, memberUserId: myUserId }
  )

  // Retain THIS epoch's blob locally, then build the ring newest-first with the
  // current key guaranteed at index 0 (the safety invariant: current messages
  // must decrypt on the first attempt, exactly as before #32).
  const currentEpoch = readStoredSectorKeyEpoch(me.encrypted_group_key) ?? 0
  await addRingEntry(myUserId, chatId, currentEpoch, me.encrypted_group_key)

  const ring: CryptoKey[] = [currentKey]
  for (const entry of await getRingEntries(myUserId, chatId)) {
    if (entry.wrapped === me.encrypted_group_key) continue // current already at [0]
    try {
      // Retained entries are NOT re-checked against today's owner. Every blob in
      // the ring was admitted by the `addRingEntry` above, i.e. only after it had
      // passed the owner binding at the epoch it belonged to; the ring is local
      // IndexedDB, so re-verifying buys nothing an XSS attacker could not already
      // do. Re-checking against the CURRENT owner was actively harmful: a single
      // voluntary owner departure (the server auto-promotes a new owner and bumps
      // the epoch) made every entry from the previous owner's epochs throw
      // SECTOR_CREATOR_KEY_UNTRUSTED, erasing the group's whole readable history
      // for every member — exactly what the #33 ring exists to prevent.
      //
      // Matching on the blob, not on `epoch >= currentEpoch`, also keeps a
      // same-epoch-but-different key readable: two owner sessions can each mint a
      // key at one epoch, and the member that received the other one must still
      // be able to open its own already-sent messages.
      ring.push(
        await unwrapGroupKeyFromStoredPayload(privateKey, entry.wrapped, undefined, {
          chatId,
          memberUserId: myUserId,
        })
      )
    } catch {
      // Older blob no longer unwraps (our vault key changed / corrupt). Skip it —
      // that one epoch's history is unreadable, but the rest of the ring is intact.
    }
  }

  // Publish the ring for MEDIA decryption too. Messages consult
  // `groupKeyRing` directly, but media goes through the single `sharedKey`
  // prop, so without this every file uploaded before a rotation stopped
  // opening — and rotation happens on every membership change.
  setSectorMediaRing(chatId, ring)

  return { mode: 'SECTOR', chatId, groupKey: currentKey, groupKeyRing: ring }
}

/** [CALIBRATE_FRAME] :: Снятие показаний и построение крипто-контекста для сектора */
export async function buildChatCryptoContext(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<ChatCryptoContext | null> {
  const response = await fetchWithTimeout(`${API_URL}/chats/${chatId}`, { credentials: 'include' })
  if (!response.ok) return null

  const { chat, members } = (await response.json()) as SectorDetailResponse

  if (chat.type === 'public_open') return { mode: 'PUBLIC' as const }

  // Channels are plaintext broadcast on the wire (same shape as public_open);
  // WHO may post is enforced server-side via chat_members.channel_role.
  if (chat.type === 'channel') return { mode: 'PUBLIC' as const }

  // [1] DIRECT_E2E_LINK :: Прямой канал между двумя узлами
  if (chat.type === 'direct_e2e') {
    // Self-chat (Saved Messages): exactly one member, which is me. Use my own
    // public key — ECDH(myPriv, myPub) derives a deterministic, per-user AES
    // key; the server never sees plaintext because we still encrypt client-side.
    if (members.length === 1 && members[0].user_id === myUserId) {
      const me = members[0]
      if (!me.ecdh_public_key_jwk) throw new Error('ERR_MISSING_SELF_SIGNAL')
      return { mode: 'SELF', selfPublicKeyJwk: me.ecdh_public_key_jwk }
    }

    const peer = members.find((m) => m.user_id !== myUserId)
    if (!peer?.ecdh_public_key_jwk) throw new Error('ERR_MISSING_PEER_SIGNAL')

    await assertTrustOrThrow(peer.user_id, peer.ecdh_public_key_jwk)

    return { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk }
  }

  // [2] SECTOR_E2E_LINK :: Групповой зашифрованный канал стаи
  if (chat.type === 'group_e2e') {
    return await buildSectorFrame(chatId, myUserId, privateKey, members)
  }

  return null
}

/**
 * [FORWARD_FRAME] :: Like `buildChatCryptoContext` but also returns the peer
 * user id (for DIRECT) and chat type, so callers that need to construct a
 * transport payload to the chat (e.g. message forward) don't have to fetch
 * `/chats/:id` twice.
 */
export async function buildChatCryptoContextWithMeta(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<{
  ctx: ChatCryptoContext
  peerUserId: string | null
  chatType: string
} | null> {
  const response = await fetchWithTimeout(`${API_URL}/chats/${chatId}`, { credentials: 'include' })
  if (!response.ok) return null
  const { chat, members } = (await response.json()) as SectorDetailResponse

  // Channel rides the PUBLIC path here too — see buildChatCryptoContext.
  if (chat.type === 'public_open' || chat.type === 'channel') {
    return { ctx: { mode: 'PUBLIC' }, peerUserId: null, chatType: chat.type }
  }

  if (chat.type === 'direct_e2e') {
    if (members.length === 1 && members[0].user_id === myUserId) {
      const me = members[0]
      if (!me.ecdh_public_key_jwk) throw new Error('ERR_MISSING_SELF_SIGNAL')
      return {
        ctx: { mode: 'SELF', selfPublicKeyJwk: me.ecdh_public_key_jwk },
        peerUserId: null,
        chatType: chat.type,
      }
    }
    const peer = members.find((m) => m.user_id !== myUserId)
    if (!peer?.ecdh_public_key_jwk) throw new Error('ERR_MISSING_PEER_SIGNAL')

    /** [TRUST_VERIFICATION] :: Forward/media paths must also verify the trust registry */
    await assertTrustOrThrow(peer.user_id, peer.ecdh_public_key_jwk)

    return {
      ctx: { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk },
      peerUserId: peer.user_id,
      chatType: chat.type,
    }
  }

  if (chat.type === 'group_e2e') {
    // Same owner-binding + per-epoch ring as the primary builder — the
    // forward/media path must not be a weaker door into the SECTOR key.
    return {
      ctx: await buildSectorFrame(chatId, myUserId, privateKey, members),
      peerUserId: null,
      chatType: chat.type,
    }
  }

  return null
}

/** [SEAL_SIGNAL] :: Запечатывание исходящего пакета данных */
export async function encryptOutboundText(
  privateKey: CryptoKey,
  plaintext: string,
  frame: ChatCryptoContext
): Promise<{ encrypted_content: string; iv: string }> {
  if (frame.mode === 'PUBLIC') {
    return { encrypted_content: btoa(unescape(encodeURIComponent(plaintext))), iv: 'public' }
  }

  let result: { ciphertext: string; iv: string }

  if (frame.mode === 'SECTOR') {
    result = await encryptMessage(frame.groupKey, plaintext)
  } else if (frame.mode === 'SELF') {
    const myPub = await importEcdhPublicKey(frame.selfPublicKeyJwk)
    const sharedSecret = await deriveSharedSecret(privateKey, myPub)
    result = await encryptMessage(sharedSecret, plaintext)
  } else {
    const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
    const sharedSecret = await deriveSharedSecret(privateKey, peerPub)
    result = await encryptMessage(sharedSecret, plaintext)
  }

  return { encrypted_content: result.ciphertext, iv: result.iv }
}

/**
 * [RING_UNSEAL] :: Decrypt AES-GCM ciphertext against an ordered list of keys,
 * returning the first that authenticates. Keys are tried in order (current
 * epoch first), so the common case (current key) costs exactly one attempt.
 * Throws the last error if NONE succeed — a genuinely undecryptable row, same
 * failure surface as the single-key path.
 */
export async function decryptMessageWithKeys(
  keys: CryptoKey[],
  ciphertext: string,
  iv: string
): Promise<string> {
  let lastErr: unknown = new Error('ERR_NO_SECTOR_KEYS')
  for (const key of keys) {
    try {
      return await decryptMessage(key, ciphertext, iv)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/** [UNSEAL_SIGNAL] :: Вскрытие входящего пакета данных */
export async function decryptInboundText(
  privateKey: CryptoKey,
  frame: ChatCryptoContext,
  ciphertext: string,
  iv: string
): Promise<string> {
  if (frame.mode === 'PUBLIC') {
    return decodeURIComponent(escape(atob(ciphertext)))
  }

  if (frame.mode === 'SECTOR') {
    // #32 ring: try the current key first (index 0), fall back to retained
    // older-epoch keys so post-rotation history still opens.
    return decryptMessageWithKeys(frame.groupKeyRing ?? [frame.groupKey], ciphertext, iv)
  }

  if (frame.mode === 'SELF') {
    const myPub = await importEcdhPublicKey(frame.selfPublicKeyJwk)
    const sharedSecret = await deriveSharedSecret(privateKey, myPub)
    return decryptMessage(sharedSecret, ciphertext, iv)
  }

  const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
  const sharedSecret = await deriveSharedSecret(privateKey, peerPub)
  return decryptMessage(sharedSecret, ciphertext, iv)
}

/** Per-device DR fan-out slot — see `session-manager.ts` → `DrDeviceSlot`. */
export type DrFanoutSlotV2 = { device_id: string; ciphertext: string; iv: string }

/**
 * [V2_SEAL] :: Encrypt an outbound message.
 *
 * DIRECT chats are per-device Double Ratchet (track A4) ONLY — there is no
 * fallback. A malicious server must never be able to force the weaker,
 * non-sender-authenticated v1 static-ECDH path, so when no DR session can be
 * established this THROWS instead of silently downgrading. SELF / SECTOR /
 * PUBLIC use symmetric crypto with no peer ECDH, hence no downgrade vector.
 *
 * A DR v2 message is NOT a single ciphertext: each linked device (the peer's
 * devices + the sender's other devices) gets its own ratchet and its own
 * self-describing envelope. `dr_slots` carries one delivery slot per device;
 * the caller posts those as `ciphertexts[]`. `encrypted_content` is empty for
 * v2 — the sender does not address itself, and the send hook keeps the
 * original plaintext for the optimistic local echo.
 */
export async function encryptOutboundTextV2(
  privateKey: CryptoKey,
  plaintext: string,
  frame: ChatCryptoContext,
  ctx: { ownerUserId: string; peerUserId: string | null }
): Promise<{
  protocol_version: 1 | 2
  encrypted_content: string
  iv: string
  dr_header: string | null
  dr_init: string | null
  /** v2 only: one delivery slot per device. Empty/absent for v1. */
  dr_slots?: DrFanoutSlotV2[]
}> {
  // DIRECT: Double Ratchet only. No fallback — the send path must never be
  // downgraded to the unauthenticated v1 static-ECDH scheme.
  if (frame.mode === 'DIRECT') {
    if (!ctx.peerUserId) throw new Error('ERR_NO_DR_KEYS')
    const { getDrFanoutSafety, DR_SLOT_SENTINEL } = await import('@/lib/fanout-crypto')
    const safety = await getDrFanoutSafety(ctx.ownerUserId, ctx.peerUserId)
    if (!safety.safe) throw new Error('ERR_NO_DR_KEYS')
    const { encryptForPeer } = await import('@/lib/ratchet/session-manager')
    const fanout = await encryptForPeer(ctx.ownerUserId, ctx.peerUserId, plaintext)
    if (fanout.slots.length === 0) throw new Error('ERR_NO_DR_KEYS')
    return {
      protocol_version: 2,
      // v2 device fan-out: no shared ciphertext / header on the message row.
      encrypted_content: '',
      iv: DR_SLOT_SENTINEL,
      dr_header: null,
      dr_init: null,
      dr_slots: fanout.slots.map((s) => ({
        device_id: s.deviceId,
        ciphertext: s.envelope,
        iv: DR_SLOT_SENTINEL,
      })),
    }
  }
  // SELF / SECTOR / PUBLIC — symmetric crypto, single party or shared key,
  // no peer ECDH and therefore no protocol-downgrade vector.
  const legacy = await encryptOutboundText(privateKey, plaintext, frame)
  return { protocol_version: 1, ...legacy, dr_header: null, dr_init: null }
}

/** [V2_UNSEAL] :: Decrypt a message whose frame is tagged v1 or v2.
 *
 * For v2 (per-device DR), `encrypted_content` holds the device delivery
 * slot's self-describing `DrDeviceEnvelope` JSON. The envelope itself carries
 * the DR header, ciphertext, sender device id, and (first message only) the
 * X3DH init — there is no longer a separate `dr_header` / `dr_init`. */
export async function decryptInboundTextV2(
  privateKey: CryptoKey,
  frame: ChatCryptoContext,
  envelope: {
    protocol_version: number
    encrypted_content: string
    iv: string
    dr_header: string | null
    dr_init?: string | null
  },
  ctx: { ownerUserId: string; peerUserId: string | null }
): Promise<string> {
  if (envelope.protocol_version === 2) {
    if (!ctx.peerUserId || !envelope.encrypted_content) {
      throw new Error('ERR_DR_METADATA_MISSING')
    }
    const sm = await import('@/lib/ratchet/session-manager')
    const { parseDrDeviceEnvelope } = await import('@/lib/dr-envelope')
    const drEnv = parseDrDeviceEnvelope(envelope.encrypted_content)
    if (!drEnv) throw new Error('ERR_DR_ENVELOPE_INVALID')
    return sm.decryptFromPeer(ctx.ownerUserId, ctx.peerUserId, drEnv)
  }
  return decryptInboundText(privateKey, frame, envelope.encrypted_content, envelope.iv)
}

/** [EXTRACT_SECTOR_KEY] :: Получение AES-GCM ключа для текущего линка */
export async function getAesKeyForChat(
  privateKey: CryptoKey,
  frame: ChatCryptoContext
): Promise<CryptoKey | null> {
  if (frame.mode === 'PUBLIC') return null
  if (frame.mode === 'SECTOR') return frame.groupKey

  if (frame.mode === 'SELF') {
    const myPub = await importEcdhPublicKey(frame.selfPublicKeyJwk)
    return deriveSharedSecret(privateKey, myPub)
  }

  const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
  return deriveSharedSecret(privateKey, peerPub)
}

/**
 * [EXTRACT_SECTOR_KEY_RING] :: Like {@link getAesKeyForChat} but returns the
 * ORDERED key list for DECRYPT paths (current epoch first, then retained older
 * epochs). SECTOR yields its ring; SELF/DIRECT a single-element list; PUBLIC
 * null. Encrypt/send callers keep using `getAesKeyForChat` (the current key).
 */
export async function getAesKeyRingForChat(
  privateKey: CryptoKey,
  frame: ChatCryptoContext
): Promise<CryptoKey[] | null> {
  if (frame.mode === 'PUBLIC') return null
  if (frame.mode === 'SECTOR') return frame.groupKeyRing ?? [frame.groupKey]
  const single = await getAesKeyForChat(privateKey, frame)
  return single ? [single] : null
}

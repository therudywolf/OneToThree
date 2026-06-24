// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  importEcdhPublicKey,
} from './crypto'
import { unwrapGroupKeyFromStoredPayload } from './chat-logic'

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
  | { mode: 'SECTOR'; groupKey: CryptoKey }
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
 * Сравниваются только криптографически значимые поля JWK (kty/crv/x/y),
 * чтобы избежать ложных тревог при разных необязательных полях (key_ops, ext…).
 * Бросает исключение при несовпадении закреплённого и полученного ключа,
 * а также если реестр доверия повреждён (fail-closed — повреждённый реестр
 * никогда не должен молча «расцеплять» все pin'ы).
 *
 * Named `assertTrustOrThrow` to make the throwing contract explicit at call
 * sites. Both `buildChatCryptoContext` and `buildChatCryptoContextWithMeta`
 * must call this so that neither the primary path nor the meta/forward path
 * can bypass trust verification.
 */
export function assertTrustOrThrow(peerUserId: string, receivedJwk: string): void {
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
  const keyFields = ['crv', 'kty', 'x', 'y'] as const
  const extractKey = (jwk: unknown) => {
    if (typeof jwk !== 'string') return JSON.stringify(jwk)
    try {
      const parsed = JSON.parse(jwk) as Record<string, unknown>
      return JSON.stringify(Object.fromEntries(keyFields.map((k) => [k, parsed[k] ?? null])))
    } catch {
      return jwk
    }
  }
  if (extractKey(pinnedSignal) !== extractKey(receivedJwk)) {
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

    assertTrustOrThrow(peer.user_id, peer.ecdh_public_key_jwk)

    return { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk }
  }

  // [2] SECTOR_E2E_LINK :: Групповой зашифрованный канал стаи
  if (chat.type === 'group_e2e') {
    const me = members.find((m) => m.user_id === myUserId)
    if (!me?.encrypted_group_key) throw new Error('ERR_MISSING_SECTOR_KEY')

    // D2: bind the wrap to the OWNER's pinned ECDH key so a server- or
    // admin-substituted key is rejected (fail-closed) rather than silently
    // adopted, which would hand the attacker full group read/inject.
    const ownerEcdhJwk = resolveSectorOwnerEcdhJwk(members)
    const sectorKey = await unwrapGroupKeyFromStoredPayload(
      privateKey,
      me.encrypted_group_key,
      ownerEcdhJwk
    )
    return { mode: 'SECTOR', groupKey: sectorKey }
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

  if (chat.type === 'public_open') {
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
    assertTrustOrThrow(peer.user_id, peer.ecdh_public_key_jwk)

    return {
      ctx: { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk },
      peerUserId: peer.user_id,
      chatType: chat.type,
    }
  }

  if (chat.type === 'group_e2e') {
    const me = members.find((m) => m.user_id === myUserId)
    if (!me?.encrypted_group_key) throw new Error('ERR_MISSING_SECTOR_KEY')
    // D2: same owner-binding as the primary builder — the forward/media path
    // must not be a weaker door into the SECTOR key.
    const ownerEcdhJwk = resolveSectorOwnerEcdhJwk(members)
    const sectorKey = await unwrapGroupKeyFromStoredPayload(
      privateKey,
      me.encrypted_group_key,
      ownerEcdhJwk
    )
    return {
      ctx: { mode: 'SECTOR', groupKey: sectorKey },
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
    return decryptMessage(frame.groupKey, ciphertext, iv)
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

'use client'

import { API_URL } from '@/lib/api/auth'
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

/** [CALIBRATE_FRAME] :: Снятие показаний и построение крипто-контекста для сектора */
export async function buildChatCryptoContext(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<ChatCryptoContext | null> {
  const response = await fetch(`${API_URL}/chats/${chatId}`, { credentials: 'include' })
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

    /** [TRUST_VERIFICATION] :: Проверка отпечатка в локальном реестре */
    const registryRaw = localStorage.getItem('p13_trust_registry')
    if (registryRaw) {
      try {
        const registry = JSON.parse(registryRaw)
        const pinnedSignal = registry[peer.user_id]
        
        if (pinnedSignal) {
          const normalize = (jwk: string) => JSON.stringify(JSON.parse(jwk), Object.keys(JSON.parse(jwk)).sort())
          if (normalize(pinnedSignal) !== normalize(peer.ecdh_public_key_jwk)) {
            throw new Error('SECURITY_SIGNAL_MISMATCH :: COMPROMISED_LINK')
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('MISMATCH')) throw err
      }
    }

    return { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk }
  }

  // [2] SECTOR_E2E_LINK :: Групповой зашифрованный канал стаи
  if (chat.type === 'group_e2e') {
    const me = members.find((m) => m.user_id === myUserId)
    if (!me?.encrypted_group_key) throw new Error('ERR_MISSING_SECTOR_KEY')

    // Вскрытие ключа сектора (KEK-протокол)
    const sectorKey = await unwrapGroupKeyFromStoredPayload(privateKey, me.encrypted_group_key)
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
  const response = await fetch(`${API_URL}/chats/${chatId}`, { credentials: 'include' })
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
    return {
      ctx: { mode: 'DIRECT', peerPublicKeyJwk: peer.ecdh_public_key_jwk },
      peerUserId: peer.user_id,
      chatType: chat.type,
    }
  }

  if (chat.type === 'group_e2e') {
    const me = members.find((m) => m.user_id === myUserId)
    if (!me?.encrypted_group_key) throw new Error('ERR_MISSING_SECTOR_KEY')
    const sectorKey = await unwrapGroupKeyFromStoredPayload(privateKey, me.encrypted_group_key)
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

/**
 * [V2_SEAL] :: Encrypt a DIRECT message using the Double Ratchet if a session
 * already exists, otherwise transparently fall back to static ECDH (v1).
 *
 * Callers should persist the returned `protocol_version` and `dr_header`
 * alongside the ciphertext in `messages.protocol_version` / `messages.dr_header`.
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
}> {
  // Double Ratchet does not apply to Saved Messages (single participant)
  // — fall straight through to the symmetric v1 path.
  if (frame.mode === 'DIRECT' && ctx.peerUserId) {
    try {
      const { encryptForPeer } = await import('@/lib/ratchet/session-manager')
      const wire = await encryptForPeer(ctx.ownerUserId, ctx.peerUserId, plaintext)
      return {
        protocol_version: 2,
        encrypted_content: wire.encrypted_content,
        iv: wire.iv,
        dr_header: wire.drHeader,
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message !== 'RATCHET_NO_SESSION'
      ) {
        throw err
      }
      // No DR session yet — fall through to legacy v1 path.
    }
  }
  const legacy = await encryptOutboundText(privateKey, plaintext, frame)
  return { protocol_version: 1, ...legacy, dr_header: null }
}

/** [V2_UNSEAL] :: Decrypt a message whose frame is tagged v1 or v2. */
export async function decryptInboundTextV2(
  privateKey: CryptoKey,
  frame: ChatCryptoContext,
  envelope: {
    protocol_version: number
    encrypted_content: string
    iv: string
    dr_header: string | null
  },
  ctx: { ownerUserId: string; peerUserId: string | null }
): Promise<string> {
  if (envelope.protocol_version === 2) {
    if (!ctx.peerUserId || !envelope.dr_header) {
      throw new Error('ERR_DR_METADATA_MISSING')
    }
    const { decryptFromPeer } = await import('@/lib/ratchet/session-manager')
    return decryptFromPeer(ctx.ownerUserId, ctx.peerUserId, {
      protocolVersion: 2,
      drHeader: envelope.dr_header,
      iv: envelope.iv,
      encrypted_content: envelope.encrypted_content,
    })
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
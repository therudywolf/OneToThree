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

export type EncryptionFrame =
  | { mode: 'DIRECT'; peerPublicKeyJwk: string }
  | { mode: 'SECTOR'; groupKey: CryptoKey }

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
export async function calibrateEncryptionFrame(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<EncryptionFrame | null> {
  const response = await fetch(`${API_URL}/chats/${chatId}`, { credentials: 'include' })
  if (!response.ok) return null

  const { chat, members } = (await response.json()) as SectorDetailResponse

  if (chat.type === 'public_open') return null

  // [1] DIRECT_E2E_LINK :: Прямой канал между двумя узлами
  if (chat.type === 'direct_e2e') {
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

/** [SEAL_SIGNAL] :: Запечатывание исходящего пакета данных */
export async function sealSignal(
  privateKey: CryptoKey,
  plaintext: string,
  frame: EncryptionFrame
): Promise<{ encrypted_content: string; iv: string }> {
  let result: { ciphertext: string; iv: string }

  if (frame.mode === 'SECTOR') {
    result = await encryptMessage(frame.groupKey, plaintext)
  } else {
    const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
    const sharedSecret = await deriveSharedSecret(privateKey, peerPub)
    result = await encryptMessage(sharedSecret, plaintext)
  }

  return { encrypted_content: result.ciphertext, iv: result.iv }
}

/** [UNSEAL_SIGNAL] :: Вскрытие входящего пакета данных */
export async function unsealSignal(
  privateKey: CryptoKey,
  frame: EncryptionFrame,
  ciphertext: string,
  iv: string
): Promise<string> {
  if (frame.mode === 'SECTOR') {
    return decryptMessage(frame.groupKey, ciphertext, iv)
  }

  const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
  const sharedSecret = await deriveSharedSecret(privateKey, peerPub)
  return decryptMessage(sharedSecret, ciphertext, iv)
}

/** [EXTRACT_SECTOR_KEY] :: Получение AES-GCM ключа для текущего линка */
// --- CONSUMER_ALIASES ---
export type ChatCryptoContext = EncryptionFrame
export const buildChatCryptoContext = calibrateEncryptionFrame
export const encryptOutboundText = sealSignal
export const decryptInboundText = unsealSignal
export const getAesKeyForChat = getSectorKey

export async function getSectorKey(
  privateKey: CryptoKey,
  frame: EncryptionFrame
): Promise<CryptoKey> {
  if (frame.mode === 'SECTOR') return frame.groupKey
  
  const peerPub = await importEcdhPublicKey(frame.peerPublicKeyJwk)
  return deriveSharedSecret(privateKey, peerPub)
}
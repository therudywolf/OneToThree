'use client'

import { decryptInboundText, type ChatCryptoContext } from '@/lib/chat-crypto'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: DECODE_TRANSMISSION_ROW
 * Level: Connection Layer (Data Interpretation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export type RawSectorPacket = {
  id: string
  chat_id: string
  sender_id: string
  reply_to_id?: string | null
  encrypted_content: string | null
  iv: string | null
  media_path: string | null
  media_type: string | null
  media_iv: string | null
  created_at: string
}

/**
 * Превращает сырой пакет из БД в дешифрованный узел сообщения.
 * Возвращает null, если целостность пакета нарушена.
 */
export async function decodeTransmissionRow(
  packet: RawSectorPacket,
  privateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext
): Promise<DecryptedMessage | null> {
  let payload = ''

  // [1] INTEGRITY_CHECK :: Проверка наличия зашифрованной нагрузки
  const hasCipher = !!(packet.encrypted_content?.trim() && packet.iv?.trim())

  if (hasCipher) {
    try {
      // [2] DECRYPT_SEQUENCE :: Попытка вскрыть пакет
      payload = await decryptInboundText(
        privateKey,
        cryptoCtx,
        packet.encrypted_content!,
        packet.iv!
      )
    } catch {
      // [!] FAULT :: Пакет не может быть дешифрован текущим ключом
      console.error('>> [SYS.CRYPTO] DECODE_FAULT:', packet.id)
      return null
    }
  }

  // [3] VOID_CHECK :: Если текста нет и медиа-линк отсутствует — узел бесполезен
  if (!payload && !packet.media_path) {
    return null
  }

  // [4] MEDIA_CALIBRATION :: Валидация типов медиа-сегментов
  const mClass = packet.media_type
  const validatedClass = (mClass === 'audio' || mClass === 'video' || mClass === 'image') 
    ? mClass 
    : null

  return {
    id: packet.id,
    chat_id: packet.chat_id,
    sender_id: packet.sender_id,
    reply_to_id: packet.reply_to_id ?? null,
    plaintext: payload,
    created_at: packet.created_at,
    media_path: packet.media_path,
    media_type: validatedClass,
    media_iv: packet.media_iv,
  }
}
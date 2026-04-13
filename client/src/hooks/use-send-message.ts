'use client'

import { useCallback } from 'react'
import {
  encryptOutboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { sendChatMessageOverTransport } from '@/lib/chat-message-transport'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { cacheMessage } from '@/lib/message-cache'
import { vibrateShort } from '@/lib/vibrate'
import { useChatStore } from '@/store/chatStore'

/**
 * PROJECT 13 :: TRANSMISSION_DISPATCHER
 * Level: Connection Layer (Outbound Protocol)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export function useTransmissionDispatcher(cryptoCtx: ChatCryptoContext | null) {
  const { activeChatId, userId, unwrappedPrivateKey, appendMessage } = useChatStore()

  /** * [DISPATCH_SEQUENCE] :: Инициация передачи пакета данных 
   */
  const dispatchTransmission = useCallback(
    async (
      body: string,
      replyToId?: string | null,
      meta?: { burn_mark?: string | null }
    ) => {
      const content = body.trim()

      // [0] PRE_FLIGHT_CHECK :: Проверка целостности контура
      if (
        !content ||
        !activeChatId ||
        !userId ||
        !unwrappedPrivateKey ||
        !cryptoCtx
      ) {
        return
      }

      // [1] CRYPTO_ENCAPSULATION :: Шифрование полезной нагрузки
      const { encrypted_content, iv } = await encryptOutboundText(
        unwrappedPrivateKey,
        content,
        cryptoCtx
      )

      const burnAt = meta?.burn_mark

      // [2] TRANSPORT_DISPATCH :: Выброс пакета в эфир (WS/REST)
      const { via, serverMessage } = await sendChatMessageOverTransport({
        chat_id: activeChatId,
        content: encrypted_content,
        iv,
        reply_to_id: replyToId ?? null,
        ...(burnAt ? { burn_at: burnAt } : {}),
      })

      // [3] FEEDBACK_LOOP :: Если пакет прошел через REST, синхронизируем локальный стор
      if (via === 'rest' && serverMessage) {
        try {
          const node = await decryptApiMessageRow(
            unwrappedPrivateKey,
            cryptoCtx,
            serverMessage
          )

          // Кэшируем узел в локальном хранилище (Best-effort)
          void cacheMessage(node).catch(() => {})

          // Вшиваем узел в активный фид
          appendMessage(node)

          // [HAPTIC_SIGNAL] :: Системное подтверждение успешного линка
          vibrateShort(18)
        } catch (err) {
          console.error('>> [SYS.CRYPTO] FEEDBACK_DECRYPT_FAILURE:', err)
        }
      }
    },
    [
      activeChatId,
      userId,
      unwrappedPrivateKey,
      cryptoCtx,
      appendMessage,
    ]
  )

  return { dispatchTransmission }
}
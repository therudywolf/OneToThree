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

export function useSendMessage(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore(s => s.activeChatId)
  const userId = useChatStore(s => s.userId)
  const unwrappedPrivateKey = useChatStore(s => s.unwrappedPrivateKey)
  const appendMessage = useChatStore(s => s.appendMessage)

  /** * [DISPATCH_SEQUENCE] :: Инициация передачи пакета данных 
   */
  const dispatchTransmission = useCallback(
    async (
      body: string,
      replyToId?: string | null,
      meta?: { burn_mark?: string | null; burn_at?: string | null }
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

      const burnAt = meta?.burn_at ?? meta?.burn_mark

      // [2] TRANSPORT_DISPATCH :: Выброс пакета в эфир (WS/REST/QUEUE)
      const { via, serverMessage, outboxId } = await sendChatMessageOverTransport({
        chat_id: activeChatId,
        content: encrypted_content,
        iv,
        reply_to_id: replyToId ?? null,
        ...(burnAt ? { burn_at: burnAt } : {}),
      })

      // [3] FEEDBACK_LOOP :: Если пакет прошел через REST, синхронизируем локальный стор
      if (via === 'REST' && serverMessage) {
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

      // [4] OFFLINE_QUEUE :: Пакет в очереди на фоновую синхронизацию
      if (via === 'QUEUED' && outboxId) {
        // Show a pending placeholder in the chat feed
        appendMessage({
          id: `pending-${outboxId}`,
          chat_id: activeChatId,
          sender_id: userId,
          content: encrypted_content,
          iv,
          plaintext: content,
          media_path: null,
          media_iv: null,
          media_type: null,
          media_original_bytes: null,
          reply_to_id: replyToId ?? null,
          read_at: null,
          burn_at: burnAt ?? null,
          reactions: {},
          created_at: new Date().toISOString(),
          _pending: true,
        } as any)
        vibrateShort(8)
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

  return { dispatchTransmission, sendText: dispatchTransmission }
}


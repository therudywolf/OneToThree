'use client'

import { useCallback, useRef } from 'react'
import {
  encryptOutboundText,
  encryptOutboundTextV2,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { explainSendError } from '@/lib/explain-send-error'
import { sendChatMessageOverTransport } from '@/lib/chat-message-transport'
import {
  decryptApiMessageRow,
  type ApiMessageRow,
} from '@/lib/decrypt-chat-api-message'
import { cacheMessage } from '@/lib/message-cache'
import { vibrateShort } from '@/lib/vibrate'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { toastError } from '@/store/toastStore'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: TRANSMISSION_DISPATCHER
 * Level: Connection Layer (Outbound Protocol)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export function useSendMessage(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId: string | null
) {
  const activeChatId = useSessionStore(s => s.activeChatId)
  const userId = useSessionStore(s => s.userId)
  const unwrappedPrivateKey = useSessionStore(s => s.unwrappedPrivateKey)
  const appendMessage = useChatStore(s => s.appendMessage)
  const lastDispatchRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })

  /** * [DISPATCH_SEQUENCE] :: Инициация передачи пакета данных 
   */
  const dispatchTransmission = useCallback(
    async (
      body: string,
      replyToId?: string | null,
      meta?: { burn_mark?: string | null; burn_at?: string | null }
    ) => {
      const content = body.trim()
      const dispatchKey = `${activeChatId ?? 'none'}::${replyToId ?? 'none'}::${content}`
      const now = Date.now()
      if (
        dispatchKey === lastDispatchRef.current.key &&
        now - lastDispatchRef.current.at < 2000
      ) {
        return
      }
      lastDispatchRef.current = { key: dispatchKey, at: now }

      // [0] PRE_FLIGHT_CHECK :: Проверка целостности контура
      if (!content) return
      if (!activeChatId || !userId) {
        toastError(explainSendError(new Error(!activeChatId ? 'SEND_NO_ACTIVE_CHAT' : 'SEND_NO_USER_ID')), {
          title: 'SEND FAILED',
        })
        return
      }
      if (!unwrappedPrivateKey) {
        toastError(explainSendError(new Error('SEND_VAULT_LOCKED')), { title: 'SEND FAILED' })
        return
      }
      if (!cryptoCtx) {
        toastError(explainSendError(new Error('SEND_CRYPTO_NOT_READY')), { title: 'SEND FAILED' })
        return
      }

      let encrypted_content: string
      let iv: string
      let protocol_version: 1 | 2 = 1
      let dr_header: string | null = null
      let dr_init: string | null = null

      try {
        if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
          const enc = await encryptOutboundTextV2(unwrappedPrivateKey, content, cryptoCtx, {
            ownerUserId: userId,
            peerUserId: directPeerUserId ?? null,
          })
          encrypted_content = enc.encrypted_content
          iv = enc.iv
          protocol_version = enc.protocol_version
          dr_header = enc.dr_header
          dr_init = enc.dr_init
        } else {
          const enc = await encryptOutboundText(unwrappedPrivateKey, content, cryptoCtx)
          encrypted_content = enc.encrypted_content
          iv = enc.iv
        }
      } catch (err) {
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        return
      }

      const burnAt = meta?.burn_at ?? meta?.burn_mark

      // [2] TRANSPORT_DISPATCH :: Выброс пакета в эфир (WS/REST/QUEUE)
      let via: 'REST' | 'QUEUED'
      let serverMessage: ApiMessageRow | undefined
      let outboxId: string | undefined
      try {
        const result = await sendChatMessageOverTransport({
          chat_id: activeChatId,
          transport_mode: cryptoCtx.mode,
          plaintext: content,
          sender_private_key: unwrappedPrivateKey,
          my_user_id: userId,
          peer_user_id: directPeerUserId ?? undefined,
          content: encrypted_content,
          iv,
          protocol_version,
          dr_header,
          dr_init,
          reply_to_id: replyToId ?? null,
          ...(burnAt ? { burn_at: burnAt } : {}),
        })
        via = result.via
        serverMessage = result.serverMessage
        outboxId = result.outboxId
      } catch (err) {
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        return
      }

      // [3] FEEDBACK_LOOP :: Если пакет прошел через REST, синхронизируем локальный стор
      if (via === 'REST' && serverMessage) {
        try {
          const decrypted = await decryptApiMessageRow(
            unwrappedPrivateKey,
            cryptoCtx,
            serverMessage
          )
          const node =
            (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') &&
            (decrypted.plaintext === '' || decrypted.plaintext === '[DECRYPT_FAIL]')
              ? {
                  ...decrypted,
                  plaintext: content,
                }
              : decrypted

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
        } as unknown as DecryptedMessage)
        vibrateShort(8)
      }
    },
    [
      activeChatId,
      userId,
      unwrappedPrivateKey,
      directPeerUserId,
      cryptoCtx,
      appendMessage,
    ]
  )

  return { dispatchTransmission, sendText: dispatchTransmission }
}


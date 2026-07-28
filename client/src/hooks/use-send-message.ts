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
import { useTranslation } from '@/hooks/use-translation'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { toastError, toastWarn } from '@/store/toastStore'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: TRANSMISSION_DISPATCHER
 * Level: Connection Layer (Outbound Protocol)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * How long an identical (chat, reply-to, body) submit is treated as a
 * duplicate event rather than a second message. Long enough to absorb a
 * doubled DOM event, short enough that a human deliberately sending "ok" twice
 * is not silently swallowed.
 */
const DOUBLE_SUBMIT_WINDOW_MS = 600

export function useSendMessage(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId: string | null
) {
  const { t } = useTranslation()
  const activeChatId = useSessionStore(s => s.activeChatId)
  const userId = useSessionStore(s => s.userId)
  const unwrappedPrivateKey = useSessionStore(s => s.unwrappedPrivateKey)
  const myEcdhPublicKeyJwk = useSessionStore(s => s.myEcdhPublicKeyJwk)
  const priorMyEcdhPublicKeysJwk = useSessionStore(s => s.priorMyEcdhPublicKeysJwk)
  const appendMessage = useChatStore(s => s.appendMessage)
  const lastDispatchRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })

  /** * [DISPATCH_SEQUENCE] :: Инициация передачи пакета данных 
   */
  const dispatchTransmission = useCallback(
    async (
      body: string,
      replyToId?: string | null,
      meta?: { burn_duration_secs?: number | null }
    ) => {
      const content = body.trim()

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

      // [1] DOUBLE_SUBMIT_GUARD :: swallow a submit that fired twice for one
      // user action (Enter key-repeat, a click+touch pair), nothing more.
      //
      // It used to be a 2-second content-keyed window that was armed BEFORE the
      // network call and never disarmed, so it silently ate real messages: a
      // second "ok"/"+1"/"да" within 2s vanished with no bubble and no error
      // (the composer clears on the resolved promise), and a send that had just
      // toasted SEND FAILED could not be retried with the same text. Now the
      // window is short, and any failure disarms it so a retry always goes
      // through.
      const dispatchKey = `${activeChatId}::${replyToId ?? 'none'}::${content}`
      const now = Date.now()
      if (
        dispatchKey === lastDispatchRef.current.key &&
        now - lastDispatchRef.current.at < DOUBLE_SUBMIT_WINDOW_MS
      ) {
        return
      }
      lastDispatchRef.current = { key: dispatchKey, at: now }
      const disarmDoubleSubmitGuard = () => {
        lastDispatchRef.current = { key: '', at: 0 }
      }

      let encrypted_content: string
      let iv: string
      let protocol_version: 1 | 2 = 1
      let dr_header: string | null = null
      let dr_init: string | null = null
      let dr_slots: Array<{ device_id: string; ciphertext: string; iv: string }> | null = null

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
          dr_slots = enc.dr_slots ?? null
        } else {
          const enc = await encryptOutboundText(unwrappedPrivateKey, content, cryptoCtx)
          encrypted_content = enc.encrypted_content
          iv = enc.iv
        }
      } catch (err) {
        disarmDoubleSubmitGuard()
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        return
      }

      const burnDurationSecs = meta?.burn_duration_secs ?? null

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
          my_ecdh_public_key_jwk: myEcdhPublicKeyJwk,
          content: encrypted_content,
          iv,
          protocol_version,
          dr_header,
          dr_init,
          dr_slots,
          reply_to_id: replyToId ?? null,
          ...(burnDurationSecs != null ? { burn_duration_secs: burnDurationSecs } : {}),
        })
        via = result.via
        serverMessage = result.serverMessage
        outboxId = result.outboxId
        if (result.partialDelivery && result.partialDelivery.failedDeviceIds.length > 0) {
          toastWarn(
            `${t('chat.partialDeliveryWarning')} (${result.partialDelivery.failedDeviceIds.length}/${result.partialDelivery.attemptedDeviceIds.length})`,
            { title: t('chat.partialDeliveryTitle'), ttlMs: 7000 }
          )
        }
      } catch (err) {
        disarmDoubleSubmitGuard()
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        return
      }

      // [3] FEEDBACK_LOOP :: Если пакет прошел через REST, синхронизируем локальный стор
      if (via === 'REST' && serverMessage) {
        try {
          const decrypted = await decryptApiMessageRow(
            unwrappedPrivateKey,
            cryptoCtx,
            serverMessage,
            undefined,
            { myUserId: userId, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
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
          // Decrypt failed but the send succeeded — still surface the message
          // in the feed with the original plaintext so the sender isn't left
          // with a blank chat after sending.
          if (serverMessage) {
            appendMessage({
              id: serverMessage.id,
              chat_id: serverMessage.chat_id,
              sender_id: serverMessage.sender_id,
              reply_to_id: serverMessage.reply_to_id ?? null,
              plaintext: content,
              created_at: serverMessage.created_at,
              read_at: serverMessage.read_at ?? null,
              media_path: serverMessage.media_path ?? null,
              media_type: null,
              media_iv: serverMessage.media_iv ?? null,
              media_original_bytes: serverMessage.media_original_bytes ?? null,
              burn_at: serverMessage.burn_at ?? null,
              is_pinned: serverMessage.is_pinned ?? false,
              reactions: serverMessage.reactions ?? {},
            })
          }
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
          burn_at: null,
          burn_duration_secs: burnDurationSecs ?? null,
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
      myEcdhPublicKeyJwk,
      priorMyEcdhPublicKeysJwk,
      directPeerUserId,
      cryptoCtx,
      appendMessage,
      t,
    ]
  )

  return { dispatchTransmission, sendText: dispatchTransmission }
}


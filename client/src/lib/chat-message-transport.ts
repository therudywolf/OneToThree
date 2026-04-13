'use client'

/**
 * PROJECT 13 :: SIGNAL_DISPATCH_ORCHESTRATOR
 * Level: Connection Layer (Routing Logic)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Ensures ciphertext persistence via WebSocket or REST fallback.
 */

import { postSendChatMessage, type SendChatMessageBody } from '@/lib/api/messages'
import type { ApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { getFmSocket } from '@/lib/api/socket'
import { enqueueOutbox, registerOutboxSync } from '@/lib/outbox'

export type DispatchStatus = {
  via: 'STREAM' | 'REST' | 'QUEUED'
  serverMessage?: ApiMessageRow
  outboxId?: string
}

/**
 * [DISPATCH_SIGNAL]
 * Маршрутизация зашифрованного пакета. 
 * Приоритет: WebSocket (STREAM) для скорости, иначе REST для надежной фиксации.
 */
export async function sendChatMessageOverTransport(
  body: SendChatMessageBody
): Promise<DispatchStatus> {
  const socket = getFmSocket()

  // [1] STREAM_CHANNEL :: Попытка мгновенной передачи через активный сокет
  if (socket.connected) {
    socket.send({
      type: 'chat_message',
      ...body,
    })
    
    // В режиме STREAM сервер обычно подтверждает получение через другие события,
    // здесь мы просто фиксируем факт отправки в канал.
    return { via: 'STREAM' }
  }

  // [2] FALLBACK_REST :: Если сокет мертв, бьем напрямую в API шлюз
  try {
    const serverMessage = await postSendChatMessage(body)
    return { via: 'REST', serverMessage }
  } catch (err) {
    // [3] OFFLINE_QUEUE :: Если REST тоже не прошел — кладем в IndexedDB outbox
    // и регистрируем Background Sync для автоотправки при восстановлении сети
    try {
      const outboxId = await enqueueOutbox(body)
      await registerOutboxSync()
      console.warn('>> [SYS.TRANSPORT] QUEUED_FOR_SYNC:', outboxId)
      return { via: 'QUEUED', outboxId }
    } catch (queueErr) {
      // IndexedDB недоступен — прокидываем исходную ошибку
      console.error('>> [SYS.TRANSPORT] DISPATCH_FAULT:', err)
      throw err
    }
  }
}
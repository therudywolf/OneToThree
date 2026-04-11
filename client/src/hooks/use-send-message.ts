'use client'

import { useCallback } from 'react'
import {
  encryptOutboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { sendChatMessageOverTransport } from '@/lib/chat-message-transport'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { cacheMessage } from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'

export function useSendMessage(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const appendMessage = useChatStore((s) => s.appendMessage)

  const sendText = useCallback(
    async (
      text: string,
      replyToId?: string | null,
      opts?: { burn_at?: string | null }
    ) => {
      const t = text.trim()
      if (
        !t ||
        !activeChatId ||
        !userId ||
        !unwrappedPrivateKey ||
        !cryptoCtx
      ) {
        return
      }
      const { encrypted_content, iv } = await encryptOutboundText(
        unwrappedPrivateKey,
        t,
        cryptoCtx
      )
      const burnAt = opts?.burn_at
      const { via, serverMessage } = await sendChatMessageOverTransport({
        chat_id: activeChatId,
        content: encrypted_content,
        iv,
        reply_to_id: replyToId ?? null,
        ...(burnAt ? { burn_at: burnAt } : {}),
      })
      if (via === 'rest' && serverMessage) {
        const row = await decryptApiMessageRow(
          unwrappedPrivateKey,
          cryptoCtx,
          serverMessage
        )
        await cacheMessage(row).catch(() => {
          /* best-effort */
        })
        appendMessage(row)
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

  return { sendText }
}

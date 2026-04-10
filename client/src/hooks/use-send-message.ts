'use client'

import { useCallback } from 'react'
import {
  encryptOutboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { getFmSocket } from '@/lib/api/socket'
import { useChatStore } from '@/store/chatStore'

export function useSendMessage(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const sendText = useCallback(
    async (text: string, replyToId?: string | null) => {
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
      getFmSocket().send({
        type: 'chat_message',
        chat_id: activeChatId,
        content: encrypted_content,
        iv,
        reply_to_id: replyToId ?? null,
      })
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx]
  )

  return { sendText }
}

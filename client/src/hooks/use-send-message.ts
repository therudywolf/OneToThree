'use client'

import { useCallback } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'

export function useSendMessage(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const sendText = useCallback(
    async (text: string) => {
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
      void t
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx]
  )

  return { sendText }
}

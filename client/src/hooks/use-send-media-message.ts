'use client'

import { useCallback } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'

export function useSendMediaMessage(_cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const sendMedia = useCallback(
    async (_blob: Blob, _mediaType: 'audio' | 'video', _caption?: string) => {
      if (!activeChatId || !userId || !unwrappedPrivateKey) {
        return
      }
    },
    [activeChatId, userId, unwrappedPrivateKey]
  )

  return { sendMedia }
}

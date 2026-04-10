'use client'

import { useEffect } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'

/** Message history will load from the API in Phase 2. */
export function useLoadChatMessages(_cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setMessages = useChatStore((s) => s.setMessages)

  useEffect(() => {
    setMessages([])
  }, [activeChatId, setMessages])
}

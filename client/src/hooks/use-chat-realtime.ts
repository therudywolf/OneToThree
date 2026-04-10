'use client'

import { useEffect } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'

/**
 * Real-time delivery will use WebSockets to the Fastify server (Phase 2).
 */
export function useChatRealtime(_cryptoCtx: ChatCryptoContext | null) {
  useEffect(() => {
    // no-op until WS subscription is wired
  }, [])
}

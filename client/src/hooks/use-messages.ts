'use client'

import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatRealtime } from '@/hooks/use-chat-realtime'
import { useLoadChatMessages } from '@/hooks/use-load-chat-messages'
import { useReadReceipts } from '@/hooks/use-read-receipts'

/** REST history + WebSocket live updates + read receipts for the active chat. */
export function useMessages(cryptoCtx: ChatCryptoContext | null) {
  useLoadChatMessages(cryptoCtx)
  useChatRealtime(cryptoCtx)
  useReadReceipts()
}

'use client'

import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatRealtime } from '@/hooks/use-chat-realtime'
import { useLoadChatMessages } from '@/hooks/use-load-chat-messages'
import { useMessageDeliverySync } from '@/hooks/use-message-delivery-sync'

/** REST history + WebSocket live updates. Read receipts are wired in `ChatTerminal`. */
export function useMessages(
  cryptoCtx: ChatCryptoContext | null,
  triggerBackgroundPush?: (title: string, body: string, targetUrl?: string) => void
) {
  useLoadChatMessages(cryptoCtx)
  useMessageDeliverySync(cryptoCtx)
  useChatRealtime(cryptoCtx, triggerBackgroundPush)
}

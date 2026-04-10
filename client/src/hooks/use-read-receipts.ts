'use client'

import { useEffect, useRef } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useChatStore } from '@/store/chatStore'

/**
 * Sends a `message_read` event for the last message in the active chat
 * whenever the message list changes (i.e. new messages arrive and the user
 * has the chat open). Debounced to 500ms.
 */
export function useReadReceipts() {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const messages = useChatStore((s) => s.messages)
  const userId = useChatStore((s) => s.userId)
  const lastSentRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeChatId || !userId || messages.length === 0) return

    const last = messages[messages.length - 1]
    if (!last || last.sender_id === userId) return
    if (lastSentRef.current === last.id) return

    const timer = setTimeout(() => {
      getFmSocket().send({
        type: 'message_read',
        chat_id: activeChatId,
        message_id: last.id,
      })
      lastSentRef.current = last.id
    }, 500)

    return () => clearTimeout(timer)
  }, [activeChatId, messages, userId])
}

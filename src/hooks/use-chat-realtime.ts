'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { rowToDecryptedMessage, type DbMessageRow } from '@/lib/message-row'
import { useChatStore } from '@/store/chatStore'

/**
 * Subscribes to INSERT on `messages` for the active chat and decrypts payloads into the store.
 */
export function useChatRealtime(cryptoCtx: ChatCryptoContext | null) {
  const supabase = createClient()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const appendMessage = useChatStore((s) => s.appendMessage)

  useEffect(() => {
    if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
      return
    }

    const channel = supabase.channel(`rt:messages:${activeChatId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `chat_id=eq.${activeChatId}`,
        },
        async (payload) => {
          const row = payload.new as DbMessageRow
          try {
            const dm = await rowToDecryptedMessage(
              row,
              unwrappedPrivateKey,
              cryptoCtx
            )
            if (dm) appendMessage(dm)
          } catch {
            /* ignore */
          }
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [
    activeChatId,
    userId,
    unwrappedPrivateKey,
    cryptoCtx,
    supabase,
    appendMessage,
  ])
}

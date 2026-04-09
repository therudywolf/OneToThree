'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { decryptInboundText, type ChatCryptoContext } from '@/lib/chat-crypto'
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
          const row = payload.new as {
            id: string
            chat_id: string
            sender_id: string
            encrypted_content: string
            iv: string
            created_at: string
          }
          try {
            const plaintext = await decryptInboundText(
              unwrappedPrivateKey,
              cryptoCtx,
              row.encrypted_content,
              row.iv
            )
            appendMessage({
              id: row.id,
              chat_id: row.chat_id,
              sender_id: row.sender_id,
              plaintext,
              created_at: row.created_at,
            })
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

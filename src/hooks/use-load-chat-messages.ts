'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { decryptInboundText, type ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

export function useLoadChatMessages(cryptoCtx: ChatCryptoContext | null) {
  const supabase = createClient()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const setMessages = useChatStore((s) => s.setMessages)

  useEffect(() => {
    setMessages([])
  }, [activeChatId, setMessages])

  useEffect(() => {
    if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
      return
    }
    let cancelled = false
    ;(async () => {
      const { data: rows, error } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', activeChatId)
        .order('created_at', { ascending: true })

      if (error || cancelled || !rows) return

      const decrypted: DecryptedMessage[] = []
      for (const row of rows) {
        try {
          const plaintext = await decryptInboundText(
            unwrappedPrivateKey,
            cryptoCtx,
            row.encrypted_content,
            row.iv
          )
          decrypted.push({
            id: row.id,
            chat_id: row.chat_id,
            sender_id: row.sender_id,
            plaintext,
            created_at: row.created_at,
          })
        } catch {
          /* skip */
        }
      }
      if (!cancelled) setMessages(decrypted)
    })()
    return () => {
      cancelled = true
    }
  }, [
    activeChatId,
    userId,
    unwrappedPrivateKey,
    cryptoCtx,
    supabase,
    setMessages,
  ])
}

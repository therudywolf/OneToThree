'use client'

import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { encryptOutboundText, type ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'

/**
 * Encrypts outbound text with the active chat context and INSERTs into `messages`.
 */
export function useSendMessage(cryptoCtx: ChatCryptoContext | null) {
  const supabase = createClient()
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
      const { encrypted_content, iv } = await encryptOutboundText(
        unwrappedPrivateKey,
        t,
        cryptoCtx
      )
      const { error } = await supabase.from('messages').insert({
        chat_id: activeChatId,
        sender_id: userId,
        encrypted_content,
        iv,
      })
      if (error) throw error
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, supabase]
  )

  return { sendText }
}

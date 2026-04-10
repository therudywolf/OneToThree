'use client'

import { useEffect } from 'react'
import { API_URL } from '@/lib/api/auth'
import {
  decryptInboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

type ApiMessageRow = {
  id: string
  chat_id: string
  sender_id: string
  content: string | null
  iv: string | null
  media_path?: string | null
  media_type?: string | null
  media_iv?: string | null
  created_at: string
}

export function useLoadChatMessages(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setMessages = useChatStore((s) => s.setMessages)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  useEffect(() => {
    if (!activeChatId || !cryptoCtx || !unwrappedPrivateKey) {
      setMessages([])
      return
    }

    let cancelled = false
    ;(async () => {
      const res = await fetch(`${API_URL}/messages/${activeChatId}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        if (!cancelled) setMessages([])
        return
      }
      const data = (await res.json()) as { messages?: ApiMessageRow[] }
      const rows = data.messages ?? []
      const out: DecryptedMessage[] = []
      for (const m of rows) {
        let plaintext = ''
        if (m.content != null && m.iv != null && m.content !== '') {
          try {
            plaintext = await decryptInboundText(
              unwrappedPrivateKey,
              cryptoCtx,
              m.content,
              m.iv
            )
          } catch {
            plaintext = '[DECRYPT_FAIL]'
          }
        }
        out.push({
          id: m.id,
          chat_id: m.chat_id,
          sender_id: m.sender_id,
          plaintext,
          created_at: m.created_at,
          media_path: m.media_path,
          media_type:
            m.media_type === 'audio' || m.media_type === 'video'
              ? m.media_type
              : null,
          media_iv: m.media_iv,
        })
      }
      if (!cancelled) {
        out.sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )
        setMessages(out)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeChatId, cryptoCtx, unwrappedPrivateKey, setMessages])
}

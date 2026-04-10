'use client'

import { useEffect } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import {
  decryptInboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

export function useChatRealtime(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  useEffect(() => {
    if (!activeChatId || !cryptoCtx || !unwrappedPrivateKey) {
      return
    }

    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type === 'message_deleted') {
        if (msg.chat_id === activeChatId) removeMessage(msg.message_id)
        return
      }
      if (msg.type !== 'chat_message') return
      const m = msg.message
      if (m.chat_id !== activeChatId) return
      void (async () => {
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
        const row: DecryptedMessage = {
          id: m.id,
          chat_id: m.chat_id,
          sender_id: m.sender_id,
          plaintext,
          created_at: m.created_at,
          media_path: m.media_path,
          media_type:
            m.media_type === 'audio' ||
            m.media_type === 'video' ||
            m.media_type === 'image'
              ? m.media_type
              : null,
          media_iv: m.media_iv,
        }
        appendMessage(row)
      })()
    })

    return off
  }, [activeChatId, cryptoCtx, unwrappedPrivateKey, appendMessage, removeMessage])
}

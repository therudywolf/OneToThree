'use client'

import { useEffect, useRef } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import {
  decryptInboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { cacheMessage, deleteCachedMessage } from '@/lib/message-cache'
import { lookupUsers } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

export function useChatRealtime(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const userId = useChatStore((s) => s.userId)
  const setTypingUser = useChatStore((s) => s.setTypingUser)
  const clearTypingUser = useChatStore((s) => s.clearTypingUser)
  const clearTypingUserEverywhere = useChatStore((s) => s.clearTypingUserEverywhere)
  const pruneTypingUsers = useChatStore((s) => s.pruneTypingUsers)
  const updateMessageReadAt = useChatStore((s) => s.updateMessageReadAt)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const usernameCacheRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!activeChatId) {
      return
    }

    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type === 'typing_start') {
        if (msg.chat_id !== activeChatId) return
        if (msg.user_id === userId) return
        const known = usernameCacheRef.current[msg.user_id]
        const uname =
          msg.username?.trim() || known || `user_${msg.user_id.slice(0, 8)}`
        usernameCacheRef.current[msg.user_id] = uname
        setTypingUser(activeChatId, msg.user_id, uname, 3000)
        if (!known) {
          void lookupUsers([msg.user_id])
            .then((rows) => {
              const row = rows[0]
              if (!row?.username) return
              usernameCacheRef.current[msg.user_id] = row.username
              setTypingUser(activeChatId, msg.user_id, row.username, 3000)
            })
            .catch(() => {
              /* ignore lookup failures */
            })
        }
        return
      }
      if (msg.type === 'typing_stop') {
        if (msg.chat_id !== activeChatId) return
        clearTypingUser(activeChatId, msg.user_id)
        return
      }
      if (msg.type === 'call_leave') {
        clearTypingUserEverywhere(msg.from_user_id)
        return
      }
      if (msg.type === 'message_deleted') {
        if (msg.chat_id === activeChatId) removeMessage(msg.message_id)
        void deleteCachedMessage(msg.message_id)
        return
      }
      if (msg.type === 'message_read_update') {
        if (msg.chat_id !== activeChatId) return
        updateMessageReadAt(msg.message_id, msg.read_at)
        const row = useChatStore
          .getState()
          .messages.find((x) => x.id === msg.message_id)
        if (row) void cacheMessage({ ...row, read_at: msg.read_at })
        return
      }
      if (msg.type !== 'chat_message') return
      if (!cryptoCtx || !unwrappedPrivateKey) return
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
          reply_to_id: m.reply_to_id ?? null,
          plaintext,
          created_at: m.created_at,
          read_at: m.read_at ?? null,
          media_path: m.media_path,
          media_type:
            m.media_type === 'audio' ||
            m.media_type === 'video' ||
            m.media_type === 'image'
              ? m.media_type
              : null,
          media_iv: m.media_iv,
        }
        await cacheMessage(row)
        appendMessage(row)
      })()
    })

    return off
  }, [
    activeChatId,
    appendMessage,
    clearTypingUser,
    clearTypingUserEverywhere,
    cryptoCtx,
    pruneTypingUsers,
    removeMessage,
    setTypingUser,
    unwrappedPrivateKey,
    updateMessageReadAt,
    userId,
  ])

  useEffect(() => {
    const id = window.setInterval(() => pruneTypingUsers(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pruneTypingUsers])
}

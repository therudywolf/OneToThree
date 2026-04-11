'use client'

import { useEffect } from 'react'
import { API_URL } from '@/lib/api/auth'
import { acknowledgeMessagesDelivered } from '@/lib/api/messages'
import { type ChatCryptoContext } from '@/lib/chat-crypto'
import {
  decryptApiMessageRows,
  type ApiMessageRow,
} from '@/lib/decrypt-chat-api-message'
import { BATCH_WORKER_MIN } from '@/lib/crypto-batch-worker'
import {
  cacheMessages,
  getRecentCachedMessages,
} from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

export function useLoadChatMessages(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setMessages = useChatStore((s) => s.setMessages)
  const setHistoryDecryptBusy = useChatStore((s) => s.setHistoryDecryptBusy)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const userId = useChatStore((s) => s.userId)

  useEffect(() => {
    if (!activeChatId || !cryptoCtx || !unwrappedPrivateKey) {
      setMessages([])
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const cached = await getRecentCachedMessages(activeChatId, 50)
        if (!cancelled && cached.length > 0) {
          setMessages(cached)
        }
      } catch {
        /* IndexedDB unavailable or corrupt — continue with network fetch */
      }

      const res = await fetch(`${API_URL}/messages/${activeChatId}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        if (!cancelled) setMessages([])
        return
      }
      const data = (await res.json()) as { messages?: ApiMessageRow[] }
      const rows = data.messages ?? []
      const cipherCount = rows.filter(
        (m) => m.content != null && m.iv != null && m.content !== ''
      ).length
      const showDecryptBusy = cipherCount >= BATCH_WORKER_MIN
      if (showDecryptBusy) setHistoryDecryptBusy(true)
      let out: DecryptedMessage[] = []
      try {
        out = await decryptApiMessageRows(
          unwrappedPrivateKey,
          cryptoCtx,
          rows
        )
      } finally {
        if (showDecryptBusy) setHistoryDecryptBusy(false)
      }
      if (!cancelled) {
        out.sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )
        try {
          await cacheMessages(out)
        } catch {
          /* cache write best-effort */
        }
        setMessages(out)
        if (userId) {
          const incomingIds = out
            .filter((m) => m.sender_id !== userId)
            .map((m) => m.id)
          if (incomingIds.length > 0) {
            void acknowledgeMessagesDelivered(incomingIds).catch(() => {
              /* delivery ack is best-effort */
            })
          }
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    activeChatId,
    cryptoCtx,
    unwrappedPrivateKey,
    setMessages,
    setHistoryDecryptBusy,
    userId,
  ])
}

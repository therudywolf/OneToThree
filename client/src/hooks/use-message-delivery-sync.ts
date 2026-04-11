'use client'

import { useEffect, useRef } from 'react'
import {
  acknowledgeMessagesDelivered,
  fetchPendingDeliveries,
} from '@/lib/api/messages'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { getFmSocket } from '@/lib/api/socket'
import { cacheMessage } from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

async function pullPendingForChat(
  chatId: string,
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  appendMessage: (m: DecryptedMessage) => void
): Promise<void> {
  const rows = await fetchPendingDeliveries(chatId)
  if (rows.length === 0) return
  const ids: string[] = []
  for (const m of rows) {
    const row = await decryptApiMessageRow(
      unwrappedPrivateKey,
      cryptoCtx,
      m
    )
    await cacheMessage(row).catch(() => {
      /* best-effort */
    })
    appendMessage(row)
    ids.push(m.id)
  }
  await acknowledgeMessagesDelivered(ids)
}

export function useMessageDeliverySync(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const prevConnected = useRef(false)

  useEffect(() => {
    const socket = getFmSocket()
    const offStatus = socket.subscribeStatus(() => {
      const now = socket.connected
      if (now && !prevConnected.current) {
        const chatId = useChatStore.getState().activeChatId
        const pk = useChatStore.getState().unwrappedPrivateKey
        const ctx = cryptoCtx
        if (chatId && pk && ctx) {
          void pullPendingForChat(chatId, pk, ctx, appendMessage).catch(() => {
            /* ignore transient sync errors */
          })
        }
      }
      prevConnected.current = now
    })
    return offStatus
  }, [cryptoCtx, appendMessage])

  useEffect(() => {
    if (!activeChatId || !cryptoCtx || !unwrappedPrivateKey) return
    if (!getFmSocket().connected) return
    void pullPendingForChat(
      activeChatId,
      unwrappedPrivateKey,
      cryptoCtx,
      appendMessage
    ).catch(() => {
      /* ignore */
    })
  }, [activeChatId, cryptoCtx, unwrappedPrivateKey, appendMessage])
}

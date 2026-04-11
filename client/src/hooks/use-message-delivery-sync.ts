'use client'

import { useEffect, useRef } from 'react'
import {
  acknowledgeMessagesDelivered,
  fetchPendingDeliveries,
} from '@/lib/api/messages'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { decryptApiMessageRows } from '@/lib/decrypt-chat-api-message'
import { BATCH_WORKER_MIN } from '@/lib/crypto-batch-worker'
import { getFmSocket } from '@/lib/api/socket'
import { cacheMessage } from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

async function pullPendingForChat(
  chatId: string,
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  appendMessage: (m: DecryptedMessage) => void,
  setDecryptBusy?: (busy: boolean) => void
): Promise<void> {
  const rows = await fetchPendingDeliveries(chatId)
  if (rows.length === 0) return
  const cipherCount = rows.filter(
    (m) => m.content != null && m.iv != null && m.content !== ''
  ).length
  const showBusy = cipherCount >= BATCH_WORKER_MIN
  if (showBusy) setDecryptBusy?.(true)
  let decrypted: DecryptedMessage[] = []
  try {
    decrypted = await decryptApiMessageRows(
      unwrappedPrivateKey,
      cryptoCtx,
      rows
    )
  } finally {
    if (showBusy) setDecryptBusy?.(false)
  }
  const ids: string[] = []
  for (let i = 0; i < decrypted.length; i++) {
    const row = decrypted[i]!
    await cacheMessage(row).catch(() => {
      /* best-effort */
    })
    appendMessage(row)
    ids.push(rows[i]!.id)
  }
  await acknowledgeMessagesDelivered(ids)
}

export function useMessageDeliverySync(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const setHistoryDecryptBusy = useChatStore((s) => s.setHistoryDecryptBusy)
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
          void pullPendingForChat(
            chatId,
            pk,
            ctx,
            appendMessage,
            setHistoryDecryptBusy
          ).catch(() => {
            /* ignore transient sync errors */
          })
        }
      }
      prevConnected.current = now
    })
    return offStatus
  }, [cryptoCtx, appendMessage, setHistoryDecryptBusy])

  useEffect(() => {
    if (!activeChatId || !cryptoCtx || !unwrappedPrivateKey) return
    if (!getFmSocket().connected) return
    void pullPendingForChat(
      activeChatId,
      unwrappedPrivateKey,
      cryptoCtx,
      appendMessage,
      setHistoryDecryptBusy
    ).catch(() => {
      /* ignore */
    })
  }, [
    activeChatId,
    cryptoCtx,
    unwrappedPrivateKey,
    appendMessage,
    setHistoryDecryptBusy,
  ])
}

'use client'

import { useEffect, useRef } from 'react'
import {
  acknowledgeMessagesDelivered,
  fetchPendingDeliveries,
} from '@/lib/api/messages'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { decryptApiMessageRows, type DrContext, type DecryptHints } from '@/lib/decrypt-chat-api-message'
import { BATCH_WORKER_MIN } from '@/lib/crypto-batch-worker'
import { getFmSocket } from '@/lib/api/socket'
import { cacheMessage } from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'
import type { DecryptedMessage } from '@/types/chat'

async function pullPendingForChat(
  chatId: string,
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  drCtx: DrContext | undefined,
  appendMessage: (m: DecryptedMessage) => void,
  setDecryptBusy?: (busy: boolean) => void,
  hints?: DecryptHints
): Promise<void> {
  const rows = await fetchPendingDeliveries(chatId)
  if (rows.length === 0) return
  const cipherCount = rows.filter(
    (m) =>
      (m.device_ciphertext != null && m.device_iv != null && m.device_ciphertext !== '') ||
      (m.content != null && m.iv != null && m.content !== '')
  ).length
  const showBusy = cipherCount >= BATCH_WORKER_MIN
  if (showBusy) setDecryptBusy?.(true)
  let decrypted: DecryptedMessage[] = []
  try {
    decrypted = await decryptApiMessageRows(
      unwrappedPrivateKey,
      cryptoCtx,
      rows,
      drCtx,
      hints
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

export function useMessageDeliverySync(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId?: string | null
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const userId = useSessionStore((s) => s.userId)
  const myEcdhPublicKeyJwk = useSessionStore((s) => s.myEcdhPublicKeyJwk)
  const priorMyEcdhPublicKeysJwk = useSessionStore((s) => s.priorMyEcdhPublicKeysJwk)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const setHistoryDecryptBusy = useUnreadStore((s) => s.setHistoryDecryptBusy)
  const prevConnected = useRef(false)

  useEffect(() => {
    const socket = getFmSocket()
    const offStatus = socket.subscribeStatus(() => {
      const now = socket.connected
      if (now && !prevConnected.current) {
        const chatId = useSessionStore.getState().activeChatId
        const pk = useSessionStore.getState().unwrappedPrivateKey
        const ownerUserId = useSessionStore.getState().userId
        const myPub = useSessionStore.getState().myEcdhPublicKeyJwk
        const ctx = cryptoCtx
        const drCtx: DrContext | undefined =
          ownerUserId && directPeerUserId
            ? { ownerUserId, peerUserId: directPeerUserId }
            : undefined
        if (chatId && pk && ctx) {
          void pullPendingForChat(
            chatId,
            pk,
            ctx,
            drCtx,
            appendMessage,
            setHistoryDecryptBusy,
            {
              myUserId: ownerUserId ?? undefined,
              myEcdhPublicKeyJwk: myPub,
              priorMyEcdhPublicKeysJwk: useSessionStore.getState().priorMyEcdhPublicKeysJwk,
            }
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
    const drCtx: DrContext | undefined =
      userId && directPeerUserId
        ? { ownerUserId: userId, peerUserId: directPeerUserId }
        : undefined
    void pullPendingForChat(
      activeChatId,
      unwrappedPrivateKey,
      cryptoCtx,
      drCtx,
      appendMessage,
      setHistoryDecryptBusy,
      { myUserId: userId ?? undefined, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
    ).catch(() => {
      /* ignore */
    })
  }, [
    activeChatId,
    cryptoCtx,
    directPeerUserId,
    unwrappedPrivateKey,
    userId,
    myEcdhPublicKeyJwk,
    priorMyEcdhPublicKeysJwk,
    appendMessage,
    setHistoryDecryptBusy,
  ])
}

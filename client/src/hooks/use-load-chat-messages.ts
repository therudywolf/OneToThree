'use client'

import { useEffect } from 'react'
import { API_URL } from '@/lib/api/auth'
import { acknowledgeMessagesDelivered } from '@/lib/api/messages'
import { type ChatCryptoContext } from '@/lib/chat-crypto'
import {
  decryptApiMessageRows,
  type DrContext,
  type ApiMessageRow,
} from '@/lib/decrypt-chat-api-message'
import { BATCH_WORKER_MIN } from '@/lib/crypto-batch-worker'
import {
  cacheMessages,
  getRecentCachedMessages,
} from '@/lib/message-cache'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'
import type { DecryptedMessage } from '@/types/chat'

export function useLoadChatMessages(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId?: string | null
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const userId = useSessionStore((s) => s.userId)
  const myEcdhPublicKeyJwk = useSessionStore((s) => s.myEcdhPublicKeyJwk)
  const priorMyEcdhPublicKeysJwk = useSessionStore((s) => s.priorMyEcdhPublicKeysJwk)
  const setMessages = useChatStore((s) => s.setMessages)
  const setHistoryDecryptBusy = useUnreadStore((s) => s.setHistoryDecryptBusy)

  useEffect(() => {
    if (!activeChatId) {
      setMessages([])
      return
    }
    if (!cryptoCtx || !unwrappedPrivateKey) {
      // Keep already rendered messages while vault/session context is warming up.
      return
    }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const load = async (attempt = 0) => {
      let cached: DecryptedMessage[] = []
      try {
        cached = await getRecentCachedMessages(activeChatId, 50)
        if (!cancelled && cached.length > 0) {
          setMessages(cached)
        }
      } catch {
        /* IndexedDB unavailable or corrupt — continue with network fetch */
      }

      try {
        // Ask for an initial page matching the cache seed / viewport instead of
        // letting the server default to its 500-row max — every chat open would
        // otherwise transfer + decrypt up to 500 ciphertext rows (ECDH/DR/IndexedDB
        // work) for a UI that shows far fewer; scroll-back paginates older ones (#48).
        const res = await fetch(`${API_URL}/messages/${activeChatId}?limit=75`, {
          credentials: 'include',
        })
        if (!res.ok) {
          if (!cancelled && attempt < 1) {
            retryTimer = setTimeout(() => { void load(attempt + 1) }, 1200)
          }
          return
        }
        const data = (await res.json()) as { messages?: ApiMessageRow[] }
        const rows = data.messages ?? []
        const cipherCount = rows.filter(
          (m) =>
            (m.device_ciphertext != null && m.device_iv != null && m.device_ciphertext !== '') ||
            (m.content != null && m.iv != null && m.content !== '')
        ).length
        const showDecryptBusy = cipherCount >= BATCH_WORKER_MIN
        if (showDecryptBusy) setHistoryDecryptBusy(true)
        const drCtx: DrContext | undefined =
          userId && directPeerUserId
            ? { ownerUserId: userId, peerUserId: directPeerUserId }
            : undefined

        let out: DecryptedMessage[] = []
        try {
          out = await decryptApiMessageRows(
            unwrappedPrivateKey,
            cryptoCtx,
            rows,
            drCtx,
            { myUserId: userId ?? undefined, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
          )
        } finally {
          if (showDecryptBusy) setHistoryDecryptBusy(false)
        }

        // Preserve locally known plaintext when a history decrypt falls back to
        // empty/DECRYPT_FAIL for the same message id (common for transient DR
        // session desync windows right after chat re-open).
        if (cached.length > 0) {
          const cachedById = new Map(cached.map((m) => [m.id, m]))
          out = out.map((m) => {
            const prev = cachedById.get(m.id)
            if (!prev) return m
            const currentBad = !m.plaintext || m.plaintext === '[DECRYPT_FAIL]'
            const previousGood = Boolean(prev.plaintext) && prev.plaintext !== '[DECRYPT_FAIL]'
            if (!currentBad || !previousGood) return m
            return { ...m, plaintext: prev.plaintext }
          })
        }

        if (!cancelled) {
          out.sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          )
          try {
            // Don't persist messages that failed to decrypt — stale DECRYPT_FAIL
            // entries in IndexedDB would reappear on every subsequent chat open
            // before the fresh network decrypt completes.
            const cacheable = out.filter((m) => m.plaintext !== '[DECRYPT_FAIL]')
            await cacheMessages(cacheable)
          } catch {
            /* cache write best-effort */
          }
          setMessages(out)
          if (userId) {
            // Don't ack rows that failed to decrypt — leave them in
            // /sync/pending so a later pull (DR session now ready) can retry,
            // rather than marking them delivered while showing [DECRYPT_FAIL].
            const incomingIds = out
              .filter(
                (m) =>
                  m.sender_id !== userId &&
                  m.plaintext !== '[DECRYPT_FAIL]' &&
                  m.plaintext !== '[KEY_CHANGE_DETECTED]'
              )
              .map((m) => m.id)
            if (incomingIds.length > 0) {
              void acknowledgeMessagesDelivered(incomingIds).catch(() => {
                /* delivery ack is best-effort */
              })
            }
          }
        }
      } catch {
        if (!cancelled && attempt < 1) {
          retryTimer = setTimeout(() => { void load(attempt + 1) }, 1200)
        }
      }
    }
    void load()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [
    activeChatId,
    cryptoCtx,
    directPeerUserId,
    unwrappedPrivateKey,
    setMessages,
    setHistoryDecryptBusy,
    userId,
    myEcdhPublicKeyJwk,
    priorMyEcdhPublicKeysJwk,
  ])
}

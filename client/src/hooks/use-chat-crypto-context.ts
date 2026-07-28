'use client'

import { useEffect, useState } from 'react'
import {
  buildChatCryptoContext,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { useSessionStore } from '@/store/sessionStore'
import { getFmSocket } from '@/lib/api/socket'

export function useChatCryptoContext() {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const userId = useSessionStore((s) => s.userId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)

  const [cryptoCtx, setCryptoCtx] = useState<ChatCryptoContext | null>(null)
  const [ctxError, setCtxError] = useState<string | null>(null)
  // Bumped whenever the active chat's wrapped key may have changed on the server,
  // forcing buildChatCryptoContext to re-run and pick up the fresh blob. Without
  // this, a non-owner who receives a freshly ROTATED SECTOR key (after a member
  // departs) keeps the stale in-memory key and cannot decrypt post-rotation
  // messages until they manually switch chats. See group-key-rotation.ts / PR #6.
  const [keyRebuildNonce, setKeyRebuildNonce] = useState(0)

  // Re-fetch + rebuild the context when a WS signal says the active chat's key
  // material may have changed. `chats_updated` is the reliable post-upload signal
  // (the wrapped-key PUT broadcasts it to the affected member); `group_key_epoch`
  // is an early nudge on departure. Coalesced (debounced) so a burst of per-member
  // uploads triggers a single rebuild after the writes have landed. `chats_updated`
  // is broadcast only on membership / metadata / key writes — never per message —
  // so rebuilding the active context on it is cheap and bounded.
  useEffect(() => {
    if (!activeChatId) return
    const socket = getFmSocket()
    let timer: ReturnType<typeof setTimeout> | null = null
    const bumpSoon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setKeyRebuildNonce((n) => n + 1), 300)
    }
    const off = socket.subscribe((msg) => {
      if (msg.type === 'chats_updated') {
        bumpSoon()
      } else if (msg.type === 'group_key_epoch' && msg.chat_id === activeChatId) {
        bumpSoon()
      }
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [activeChatId])

  useEffect(() => {
    if (!activeChatId || !userId || !unwrappedPrivateKey) {
      setCryptoCtx(null)
      setCtxError(null)
      return
    }
    // Drop the PREVIOUS chat's context before awaiting the new one.
    //
    // This effect only nulled the context when there was no chat at all, so on a
    // chat switch the old frame stayed in state for the whole duration of the
    // `/chats/:id` round-trip — and every consumer reads `activeChatId` fresh
    // from the store while guarding only on `if (!cryptoCtx)`. Hitting Enter on
    // already-typed text (or an in-flight media upload completing) in that window
    // encrypted the message under the PREVIOUS group's sector key and posted it
    // to the new chat: permanently undecryptable for every member of the new
    // group, and unrecoverable via the epoch ring, which never held that key.
    // Clearing here enforces the `ChatCryptoContext.chatId` invariant for ALL
    // consumers at once instead of asking each one to remember to check it.
    setCryptoCtx(null)
    let cancelled = false
    ;(async () => {
      try {
        const ctx = await buildChatCryptoContext(
          activeChatId,
          userId,
          unwrappedPrivateKey
        )
        if (cancelled) return
        if (!ctx) {
          setCryptoCtx(null)
          setCtxError('CRYPTO_BACKEND_PENDING')
          return
        }
        setCryptoCtx(ctx)
        setCtxError(null)
      } catch (e) {
        if (!cancelled) {
          setCryptoCtx(null)
          setCtxError(e instanceof Error ? e.message : 'CRYPTO_CTX_FAIL')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeChatId, userId, unwrappedPrivateKey, keyRebuildNonce])

  return { cryptoCtx, ctxError }
}

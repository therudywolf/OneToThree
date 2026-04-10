'use client'

import { useEffect, useState } from 'react'
import {
  buildChatCryptoContext,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'

export function useChatCryptoContext() {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const [cryptoCtx, setCryptoCtx] = useState<ChatCryptoContext | null>(null)
  const [ctxError, setCtxError] = useState<string | null>(null)

  useEffect(() => {
    if (!activeChatId || !userId || !unwrappedPrivateKey) {
      setCryptoCtx(null)
      setCtxError(null)
      return
    }
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
  }, [activeChatId, userId, unwrappedPrivateKey])

  return { cryptoCtx, ctxError }
}

'use client'

import { useEffect, useState } from 'react'
import { getAesKeyForChat, type ChatCryptoContext } from '@/lib/chat-crypto'
import { useSessionStore } from '@/store/sessionStore'

/** Cached AES-GCM key for the active chat (text + media). */
export function useChatAesKey(cryptoCtx: ChatCryptoContext | null) {
  const privateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const [key, setKey] = useState<CryptoKey | null>(null)

  useEffect(() => {
    if (!cryptoCtx || !privateKey) {
      setKey(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const k = await getAesKeyForChat(privateKey, cryptoCtx)
        if (!cancelled) setKey(k)
      } catch {
        if (!cancelled) setKey(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cryptoCtx, privateKey])

  return key
}

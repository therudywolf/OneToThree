'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createDirectE2EChat } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { normalizePeerInput } from '@/lib/peer-input'
import { canonicalUserId } from '@/lib/user-id'
import { useChatStore } from '@/store/chatStore'

/**
 * PROJECT 13 :: DIRECT_LINK_GENESIS
 * Level: Connection Layer (Signal Interceptor)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

// [LOCK_MECHANISM] :: Блокировка повторных запросов в Strict Mode
const genesisLock = new Set<string>()

export function InviteChatLinkEffect({ userId }: { userId: string }) {
  const searchParams = useSearchParams()
  const { setActiveChatId } = useChatStore()
  const [errorLog, setErrorLog] = useState<string | null>(null)

  useEffect(() => {
    const rawSignal = searchParams.get('invite')?.trim()
    if (!rawSignal) return

    const peerIdRaw = normalizePeerInput(rawSignal)
    if (!peerIdRaw) return

    const peer = canonicalUserId(peerIdRaw)
    const self = canonicalUserId(userId)

    // [VALIDATION] :: Проверка на замыкание контура на самого себя
    if (peer === self) {
      setErrorLog('GENESIS_ERR // CANNOT_LINK_WITH_SELF')
      return
    }

    const sessionKey = `p13:genesis:v2:${self}:${peer}`
    if (sessionStorage.getItem(sessionKey) === '1') return

    const lockKey = `${self}::${peer}`
    if (genesisLock.has(lockKey)) return
    genesisLock.add(lockKey)

    let aborted = false

    void (async () => {
      try {
        // [1] SCAN_PHASE :: Проверка существования и ключей узла
        const [targetNode] = await lookupUsers([peer])
        
        if (!targetNode) {
          throw new Error('NODE_UNKNOWN')
        }
        
        if (!targetNode.ecdh_public_key_jwk?.trim()) {
          throw new Error('NODE_CRYPTO_MISSING')
        }

        // [2] GENESIS_PHASE :: Создание прямого E2E канала
        const chat = await createDirectE2EChat(userId, targetNode.id)
        
        if (aborted) return

        sessionStorage.setItem(sessionKey, '1')
        setActiveChatId(chat.id)
        
      } catch (e) {
        if (aborted) return
        const faultCode = e instanceof Error ? e.message : 'SIGNAL_INTERRUPTED'
        setErrorLog(`GENESIS_FAILURE // ${faultCode}`)
      } finally {
        genesisLock.delete(lockKey)
      }
    })()

    return () => {
      aborted = true
      genesisLock.delete(lockKey)
    }
  }, [searchParams, userId, setActiveChatId])

  if (!errorLog) return null

  return (
    <div
      className="pointer-events-none fixed left-4 right-4 top-20 z-[200] flex justify-center"
      role="alert"
    >
      <div className="border border-neon-red bg-black/90 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red shadow-[0_0_15px_rgba(255,0,0,0.2)] backdrop-blur-md">
        <span className="mr-2 animate-pulse font-bold">[!]</span>
        {errorLog}
      </div>
    </div>
  )
}
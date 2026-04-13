'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { markMessagesReadBatch } from '@/lib/api/messages'
import { useChatStore } from '@/store/chatStore'

/**
 * PROJECT 13 :: VISUAL_CAPTURE_SYNC
 * Level: Connection Layer (Read Receipts)
 * Vibe: Clinical Pure / Terminal Noir
 * Purpose: Batching intersection signals to synchronize node state.
 */

const BATCH_SYNC_DELAY_MS = 500

export function useReadReceipts(
  scrollRootRef: RefObject<HTMLDivElement | null>,
  opts?: { enabled?: boolean }
) {
  const activeChatId = useChatStore(s => s.activeChatId)
  const userId = useChatStore(s => s.userId)
  
  const processedRef = useRef(new Set<string>())
  const syncQueueRef = useRef(new Set<string>())
  const dispatchTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  const isEnabled = opts?.enabled ?? true

  // [1] RESET_PHASE :: Зачистка кэша при смене сектора
  useEffect(() => {
    processedRef.current.clear()
    syncQueueRef.current.clear()
    if (dispatchTimerRef.current) {
      clearTimeout(dispatchTimerRef.current)
      dispatchTimerRef.current = null
    }
  }, [activeChatId])

  // [2] FINAL_FLUSH :: Выброс остатков очереди при демонтаже узла
  useEffect(() => {
    return () => {
      if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current)
      const finalBatch = Array.from(syncQueueRef.current)
      if (finalBatch.length > 0) {
        void markMessagesReadBatch(finalBatch).catch(() => {
          /* SILENCE_FAULT */
        })
      }
    }
  }, [])

  /** [DISPATCH_PROTOCOL] :: Дебаунс-передача пакетов прочитанных ID */
  const triggerBatchSync = () => {
    if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current)
    
    dispatchTimerRef.current = setTimeout(() => {
      const batch = Array.from(syncQueueRef.current)
      if (batch.length === 0) return

      syncQueueRef.current.clear()
      
      void markMessagesReadBatch(batch).catch((err) => {
        console.error('>> [SYS.SYNC] BATCH_DISPATCH_FAILURE:', err)
        // Реинъекция пакета в очередь при отказе
        for (const id of batch) syncQueueRef.current.add(id)
      })
    }, BATCH_SYNC_DELAY_MS)
  }

  // [3] OBSERVATION_CORE
  useEffect(() => {
    if (!isEnabled || !activeChatId || !userId) return
    const root = scrollRootRef.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          
          const msgId = (entry.target as HTMLElement).dataset.messageId
          if (!msgId || processedRef.current.has(msgId)) continue

          // [VERIFICATION] :: Проверка, что сообщение чужое и еще не прочитано
          const currentMessages = useChatStore.getState().messages
          const targetNode = currentMessages.find((m) => m.id === msgId)
          if (!targetNode || targetNode.sender_id === userId) continue

          processedRef.current.add(msgId)
          syncQueueRef.current.add(msgId)
          triggerBatchSync()
        }
      },
      { root, threshold: 0.25 } // Стерильный порог захвата
    )

    const scanNodes = () => {
      const container = scrollRootRef.current
      if (!container) return
      container.querySelectorAll('[data-message-id]').forEach((el) => {
        observer.observe(el)
      })
    }

    scanNodes()

    // [MUTATION_INTERCEPT] :: Слежка за новыми узлами в DOM
    const monitor = new MutationObserver(() => scanNodes())
    monitor.observe(root, { childList: true, subtree: true })

    return () => {
      monitor.disconnect()
      observer.disconnect()
    }
  }, [isEnabled, activeChatId, userId, scrollRootRef])
}
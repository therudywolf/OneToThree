'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { markMessagesReadBatch } from '@/lib/api/messages'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'

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
  const activeChatId = useSessionStore(s => s.activeChatId)
  const userId = useSessionStore(s => s.userId)
  
  const processedRef = useRef(new Set<string>())
  const syncQueueRef = useRef(new Set<string>())
  const dispatchTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  const isEnabled = opts?.enabled ?? true

  // [1] RESET_PHASE :: flush the leaving chat's pending receipts, then clear.
  // Refs still hold the previous chat's queued ids when this re-runs on a chat
  // switch, so flush them first — FINAL_FLUSH only fires on unmount, so without
  // this a message read within the 500ms debounce window right before switching
  // chats loses its receipt and the sender's unread_count stays stale-high.
  useEffect(() => {
    const pending = Array.from(syncQueueRef.current)
    if (pending.length > 0) {
      void markMessagesReadBatch(pending).catch(() => {
        /* SILENCE_FAULT */
      })
    }
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
          
          const node = entry.target as HTMLElement
          const msgId = node.dataset.messageId
          if (!msgId || processedRef.current.has(msgId)) continue

          // Use rendered node metadata instead of chatStore snapshot to support
          // mixed lists (cached older + live messages) and effective read state.
          const senderId = node.dataset.senderId ?? ''
          const effectiveReadAt = node.dataset.readAt ?? ''
          if (!senderId || senderId === userId || effectiveReadAt) continue

          processedRef.current.add(msgId)
          syncQueueRef.current.add(msgId)
          useUnreadStore.getState().updateReadAtOverride(msgId, new Date().toISOString())
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

    // [MUTATION_INTERCEPT] :: watch for newly-added message rows only.
    // subtree:true fired scanNodes (a full O(n) querySelectorAll + observe loop)
    // on ANY descendant change — late media decode, framer-motion attribute
    // churn, per-second burn countdowns — pure overhead in a busy chat. Message
    // rows are DIRECT children, so childList without subtree suffices; coalesce
    // bursts into one rAF-batched scan (#8).
    let scheduled = false
    const scheduleScan = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        scanNodes()
      })
    }
    const monitor = new MutationObserver(scheduleScan)
    monitor.observe(root, { childList: true, subtree: false })

    return () => {
      monitor.disconnect()
      observer.disconnect()
    }
  }, [isEnabled, activeChatId, userId, scrollRootRef])
}
'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { markMessagesReadBatch } from '@/lib/api/messages'
import { useChatStore } from '@/store/chatStore'

const BATCH_DEBOUNCE_MS = 500

/**
 * When peer messages scroll into view in the active chat, mark them read (REST).
 * Uses batch API with debouncing to prevent spam when scrolling through many messages.
 * Collects message IDs for 500ms, then sends as one request.
 */
export function useReadReceipts(
  scrollRootRef: RefObject<HTMLDivElement | null>,
  opts?: { enabled?: boolean }
) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const markedRef = useRef(new Set<string>())
  const pendingBatchRef = useRef(new Set<string>())
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const enabled = opts?.enabled ?? true

  // Clear marked set when switching chats
  useEffect(() => {
    markedRef.current.clear()
    pendingBatchRef.current.clear()
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
      debounceTimeoutRef.current = null
    }
  }, [activeChatId])

  // Flush remaining batch on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
      const batch = Array.from(pendingBatchRef.current)
      if (batch.length > 0) {
        void markMessagesReadBatch(batch).catch(() => {
          /* ignore unmount errors */
        })
      }
    }
  }, [])

  // Debounced batch sender
  const flushBatch = () => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }
    debounceTimeoutRef.current = setTimeout(() => {
      const batch = Array.from(pendingBatchRef.current)
      if (batch.length > 0) {
        pendingBatchRef.current.clear()
        void markMessagesReadBatch(batch).catch(() => {
          // On error, restore to pending
          for (const id of batch) {
            pendingBatchRef.current.add(id)
          }
        })
      }
    }, BATCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    if (!enabled || !activeChatId || !userId) return
    const root = scrollRootRef.current
    if (!root) return

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const id = (e.target as HTMLElement).dataset.messageId
          if (!id) continue
          const msg = useChatStore.getState().messages.find((m) => m.id === id)
          if (!msg || msg.sender_id === userId) continue
          if (markedRef.current.has(id)) continue

          markedRef.current.add(id)
          pendingBatchRef.current.add(id)
          flushBatch()
        }
      },
      { root, threshold: [0, 0.35, 0.55, 0.85, 1] }
    )

    function observeAll(): void {
      const elRoot = scrollRootRef.current
      if (!elRoot) return
      for (const el of elRoot.querySelectorAll<HTMLElement>('[data-message-id]')) {
        obs.observe(el)
      }
    }

    observeAll()
    const mo = new MutationObserver(() => observeAll())
    mo.observe(root, { childList: true, subtree: true })

    return () => {
      mo.disconnect()
      obs.disconnect()
    }
  }, [enabled, activeChatId, userId, scrollRootRef])
}


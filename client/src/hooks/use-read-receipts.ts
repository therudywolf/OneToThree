'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { markMessageRead } from '@/lib/api/messages'
import { useChatStore } from '@/store/chatStore'

/**
 * When peer messages scroll into view in the active chat, mark them read (REST).
 * Uses the chat scroll container as IntersectionObserver root.
 */
export function useReadReceipts(
  scrollRootRef: RefObject<HTMLDivElement | null>,
  opts?: { enabled?: boolean }
) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const markedRef = useRef(new Set<string>())
  const enabled = opts?.enabled ?? true

  useEffect(() => {
    markedRef.current.clear()
  }, [activeChatId])

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
          void markMessageRead(id).catch(() => {
            markedRef.current.delete(id)
          })
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

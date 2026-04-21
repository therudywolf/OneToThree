'use client'

import { useEffect } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'

/**
 * PROJECT 13 :: APP_BADGE_PROTOCOL
 * Level: OS Integration Layer (Badging API)
 *
 * Updates the PWA app icon badge with unread message count.
 * Uses navigator.setAppBadge / navigator.clearAppBadge.
 */

function isBadgingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'setAppBadge' in navigator &&
    typeof navigator.setAppBadge === 'function'
  )
}

export function useAppBadge(userId: string | null) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const unreadTotal = useUnreadStore((s) => s.unreadTotal)
  const markChatRead = useUnreadStore((s) => s.markChatRead)

  useEffect(() => {
    if (typeof document === 'undefined') return

    const syncVisibleRead = () => {
      if (document.visibilityState === 'visible' && activeChatId) {
        markChatRead(activeChatId)
      }
    }

    syncVisibleRead()
    document.addEventListener('visibilitychange', syncVisibleRead)
    window.addEventListener('focus', syncVisibleRead)

    return () => {
      document.removeEventListener('visibilitychange', syncVisibleRead)
      window.removeEventListener('focus', syncVisibleRead)
    }
  }, [activeChatId, markChatRead])

  useEffect(() => {
    if (!userId || !activeChatId) return
    markChatRead(activeChatId)
  }, [activeChatId, markChatRead, userId])

  useEffect(() => {
    if (!isBadgingSupported()) return
    if (!userId || unreadTotal <= 0) {
      navigator.clearAppBadge?.().catch(() => {})
      return
    }
    navigator.setAppBadge?.(unreadTotal).catch(() => {})
  }, [unreadTotal, userId])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const titleBase = 'OneToThree'
    if (!userId || unreadTotal <= 0) {
      document.title = titleBase
      return
    }
    document.title = `(${unreadTotal > 99 ? '99+' : unreadTotal}) ${titleBase}`
  }, [unreadTotal, userId])
}

'use client'

import { useEffect, useRef } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useChatStore } from '@/store/chatStore'

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
  const activeChatId = useChatStore((s) => s.activeChatId)
  const unreadRef = useRef(0)

  // Clear badge when app comes to foreground or user opens a chat
  useEffect(() => {
    if (!isBadgingSupported()) return

    const clearOnFocus = () => {
      unreadRef.current = 0
      navigator.clearAppBadge?.().catch(() => {})
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') clearOnFocus()
    })
    window.addEventListener('focus', clearOnFocus)

    return () => {
      window.removeEventListener('focus', clearOnFocus)
    }
  }, [])

  // Reset badge count when user opens any chat
  useEffect(() => {
    if (!activeChatId || !isBadgingSupported()) return
    unreadRef.current = Math.max(0, unreadRef.current - 1)
    if (unreadRef.current <= 0) {
      unreadRef.current = 0
      navigator.clearAppBadge?.().catch(() => {})
    } else {
      navigator.setAppBadge?.(unreadRef.current).catch(() => {})
    }
  }, [activeChatId])

  // Listen for incoming messages and increment badge
  useEffect(() => {
    if (!userId || !isBadgingSupported()) return

    const socket = getFmSocket()
    return socket.subscribe((msg) => {
      if (msg.type !== 'chat_message') return
      const m = msg.message
      // Only badge for messages from others
      if (m.sender_id === userId) return

      // Only badge if app is not focused or chat is not active
      if (document.visibilityState === 'visible' && m.chat_id === useChatStore.getState().activeChatId) return

      unreadRef.current++
      navigator.setAppBadge?.(unreadRef.current).catch(() => {})
    })
  }, [userId])
}

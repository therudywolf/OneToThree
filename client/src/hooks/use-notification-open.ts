'use client'

import { useEffect } from 'react'
import { parseTargetChatIdFromUrl } from '@/lib/notification-open'
import { useSessionStore } from '@/store/sessionStore'

type SwMessageData = {
  type?: string
  url?: string
}

export function useNotificationOpen() {
  const setActiveChatId = useSessionStore((s) => s.setActiveChatId)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const onMessage = (ev: MessageEvent<SwMessageData>) => {
      if (ev.data?.type !== 'notification_click') return
      const chatId = parseTargetChatIdFromUrl(ev.data.url ?? '', window.location.origin)
      if (chatId) setActiveChatId(chatId)
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [setActiveChatId])
}


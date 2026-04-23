'use client'

import { useEffect, useRef } from 'react'
import { parseTargetChatIdFromUrl, parseAcceptCallFromUrl } from '@/lib/notification-open'
import { useSessionStore } from '@/store/sessionStore'

type SwMessageData = {
  type?: string
  url?: string
}

type CapacitorPushAction = {
  notification?: {
    data?: {
      url?: string
      chat_id?: string
      accept_call?: string
    }
  }
}

// acceptIncomingCall is passed as an optional stable callback so the hook can
// trigger call acceptance from push notification "Answer" actions.
export function useNotificationOpen(acceptIncomingCall?: () => void) {
  const setActiveChatId = useSessionStore((s) => s.setActiveChatId)
  // Keep a stable ref so the effect closure always sees the latest version.
  const acceptRef = useRef(acceptIncomingCall)
  useEffect(() => { acceptRef.current = acceptIncomingCall }, [acceptIncomingCall])

  useEffect(() => {
    // Handle accept_call=1 in the initial page URL (opened via notification "Answer" button).
    if (typeof window === 'undefined') return
    const shouldAccept = parseAcceptCallFromUrl(window.location.href)
    if (!shouldAccept) return
    // Delay slightly so the call store has time to populate incomingCall from WS.
    const tm = window.setTimeout(() => { acceptRef.current?.() }, 800)
    return () => window.clearTimeout(tm)
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const onMessage = (ev: MessageEvent<SwMessageData>) => {
      if (ev.data?.type !== 'notification_click') return
      const url = ev.data.url ?? ''
      const chatId = parseTargetChatIdFromUrl(url, window.location.origin)
      if (chatId) setActiveChatId(chatId)
      // Accept call when user tapped "Answer" action on push notification.
      if (parseAcceptCallFromUrl(url, window.location.origin)) {
        window.setTimeout(() => { acceptRef.current?.() }, 400)
      }
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [setActiveChatId])

  useEffect(() => {
    const w = window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean
        Plugins?: {
          PushNotifications?: {
            addListener: (
              eventName: 'pushNotificationActionPerformed',
              listenerFunc: (payload: CapacitorPushAction) => void
            ) => Promise<{ remove: () => void }>
          }
        }
      }
    }
    if (!w.Capacitor?.isNativePlatform?.()) return
    const plugin = w.Capacitor?.Plugins?.PushNotifications
    if (!plugin) return

    let remove: (() => void) | null = null
    void plugin
      .addListener('pushNotificationActionPerformed', (payload) => {
        const url = payload.notification?.data?.url ?? ''
        const chatId =
          payload.notification?.data?.chat_id ??
          parseTargetChatIdFromUrl(url, window.location.origin)
        if (chatId) setActiveChatId(chatId)
        if (payload.notification?.data?.accept_call === '1' || parseAcceptCallFromUrl(url, window.location.origin)) {
          window.setTimeout(() => {
            acceptRef.current?.()
          }, 400)
        }
      })
      .then((h) => {
        remove = () => h.remove()
      })
      .catch(() => {
        remove = null
      })

    return () => {
      remove?.()
    }
  }, [setActiveChatId])
}

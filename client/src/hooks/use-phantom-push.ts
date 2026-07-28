'use client'

import { useCallback } from 'react'

/**
 * PROJECT 13 :: PHANTOM_INTERCEPT_HOOK
 * Level: Interface Layer (OS Alerts)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Emitting signal alerts when the node is in a background (hidden) state.
 */

// --- CONSUMER_ALIAS ---
export const usePhantomPush = usePhantomIntercept

/**
 * Callers pass `/?chat=<id>` as the target URL. Recover the chat id so each
 * chat gets its own notification tag: with one shared tag every later message
 * silently REPLACED the previous notification (and without `renotify` it did
 * not even re-alert), so a message from another chat destroyed the earlier
 * alert and the user never learned about it.
 */
function chatIdFromTargetUrl(targetUrl?: string): string {
  if (!targetUrl) return 'general'
  try {
    return new URL(targetUrl, window.location.origin).searchParams.get('chat') || 'general'
  } catch {
    return 'general'
  }
}

export function usePhantomIntercept() {
  /** * [EMIT_SIGNAL] :: Генерация системного уведомления.
   * Срабатывает только если вкладка скрыта (document.hidden).
   */
  const emitPhantomSignal = useCallback((label: string, _content: string, targetUrl?: string) => {
    const isPhantom = document.hidden
    const hasAuthority = 'Notification' in window && Notification.permission === 'granted'

    if (isPhantom && hasAuthority) {
      // Use SW showNotification() instead of new Notification() to ensure
      // notifications work in all contexts (including iOS PWA) and to avoid
      // leaking plaintext message content in the notification body.
      if ('serviceWorker' in navigator) {
        const chatId = chatIdFromTargetUrl(targetUrl)
        navigator.serviceWorker.ready.then((registration) => {
          registration.showNotification(label, {
            // SECURITY: never pass plaintext message content in body —
            // notification payloads are visible to the OS notification center.
            body: 'New message',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            // Same tag scheme as the SW push handler, so a push and this
            // in-app alert for the same chat collapse instead of duplicating.
            tag: `chat-${chatId}`,
            renotify: true,
            silent: false,
            data: { url: targetUrl || '/' },
          } as NotificationOptions)
        }).catch(() => {
          /* SW not yet active — notification silently dropped */
        })
      }
    }
  }, [])

  return { emitPhantomSignal }
}

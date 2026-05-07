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
        navigator.serviceWorker.ready.then((registration) => {
          registration.showNotification(label, {
            // SECURITY: never pass plaintext message content in body —
            // notification payloads are visible to the OS notification center.
            body: 'New message',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: 'p13-intercept',
            silent: false,
            data: { url: targetUrl || '/' },
          })
        }).catch(() => {
          /* SW not yet active — notification silently dropped */
        })
      }
    }
  }, [])

  return { emitPhantomSignal }
}

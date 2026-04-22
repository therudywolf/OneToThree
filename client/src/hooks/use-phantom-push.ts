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
  const emitPhantomSignal = useCallback((label: string, content: string, targetUrl?: string) => {
    const isPhantom = document.hidden
    const hasAuthority = 'Notification' in window && Notification.permission === 'granted'

    if (isPhantom && hasAuthority) {
      const signal = new Notification(label, {
        body: content,
        icon: '/icon-192.png', // Системная метка узла
        badge: '/icon-192.png',
        tag: 'p13-intercept', // Группировка сигналов в один стек
        silent: false, // Оставляем системный акустический отклик
      })

      signal.onclick = function () {
        /** [FOCUS_LOCK] :: Возврат к активному терминалу при перехвате */
        if (targetUrl) {
          try {
            const nextUrl = new URL(targetUrl, window.location.origin).href
            if (window.location.href !== nextUrl) {
              window.location.assign(nextUrl)
            }
          } catch {
            /* ignore malformed local notification url */
          }
        }
        window.focus()
        this.close()
      }
    }
  }, [])

  return { emitPhantomSignal }
}

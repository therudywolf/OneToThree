'use client'

import { useEffect, useCallback } from 'react'

/**
 * PROJECT 13 :: PHANTOM_INTERCEPT_HOOK
 * Level: Interface Layer (OS Alerts)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Emitting signal alerts when the node is in a background (hidden) state.
 */

export function usePhantomIntercept() {
  useEffect(() => {
    /** [PROTOCOL_INIT] :: Запрос полномочий на прерывание в спящем режиме */
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])

  /** * [EMIT_SIGNAL] :: Генерация системного уведомления.
   * Срабатывает только если вкладка скрыта (document.hidden).
   */
  const emitPhantomSignal = useCallback((label: string, content: string) => {
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
        window.focus()
        this.close()
      }
    }
  }, [])

  return { emitPhantomSignal }
}
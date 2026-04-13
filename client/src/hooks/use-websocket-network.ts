'use client'

import { useEffect, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'

/**
 * PROJECT 13 :: SIGNAL_MONITOR_PROTOCOL
 * Level: Network Layer (Pulse Tracking)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export type SignalPulse = {
  /** [PULSE] :: Статус физического линка браузера */
  is_online: boolean
  /** [LINK] :: Состояние WebSocket-контура */
  is_linked: boolean
  /** [BUFFER] :: Глубина очереди пакетов, ожидающих отправки */
  buffer_depth: number
}

/**
 * Централизованный мониторинг сетевого статуса узла.
 * Используется для UI-индикаторов в шапке терминала.
 */
export function useSignalMonitor(): SignalPulse {
  const [is_online, setIsOnline] = useState(true)
  const [is_linked, setIsLinked] = useState(false)
  const [buffer_depth, setBufferDepth] = useState(0)

  useEffect(() => {
    const handlePulseUp = () => setIsOnline(true)
    const handlePulseDown = () => setIsOnline(false)

    window.addEventListener('online', handlePulseUp)
    window.addEventListener('offline', handlePulseDown)
    
    // Инициализация текущего состояния линка
    setIsOnline(navigator.onLine)

    return () => {
      window.removeEventListener('online', handlePulseUp)
      window.removeEventListener('offline', handlePulseDown)
    }
  }, [])

  useEffect(() => {
    const socket = getFmSocket()

    /** [SYNC] :: Подписка на изменение состояния сокета */
    const unsubscribe = socket.subscribeStatus(() => {
      setIsLinked(socket.connected)
      setBufferDepth(socket.queuedCount)
    })

    return unsubscribe
  }, [])

  return { is_online, is_linked, buffer_depth }
}
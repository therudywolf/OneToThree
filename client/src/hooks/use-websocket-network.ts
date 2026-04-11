'use client'

import { useEffect, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'

export type WebSocketNetworkState = {
  online: boolean
  wsConnected: boolean
  queuedCount: number
}

/**
 * Centralized network status hook for UI indicators.
 * Keeps browser connectivity and websocket queue/connection state in one place.
 */
export function useWebSocketNetwork(): WebSocketNetworkState {
  const [online, setOnline] = useState(true)
  const [wsConnected, setWsConnected] = useState(false)
  const [queuedCount, setQueuedCount] = useState(0)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    setOnline(navigator.onLine)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    const socket = getFmSocket()
    const off = socket.subscribeStatus(() => {
      setWsConnected(socket.connected)
      setQueuedCount(socket.queuedCount)
    })
    return off
  }, [])

  return { online, wsConnected, queuedCount }
}


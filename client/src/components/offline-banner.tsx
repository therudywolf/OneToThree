'use client'

import { useEffect, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'

export function OfflineBanner() {
  const [online, setOnline] = useState(true)
  const [wsConnected, setWsConnected] = useState(true)

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
    const iv = setInterval(() => {
      setWsConnected(getFmSocket().connected)
    }, 2000)
    return () => clearInterval(iv)
  }, [])

  if (online && wsConnected) return null

  return (
    <div className="animate-pulse border-b border-neon-red bg-red-950/80 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red">
      {!online
        ? ':: NETWORK_OFFLINE — NO_UPLINK'
        : ':: SOCKET_DISCONNECTED — RECONNECTING…'}
    </div>
  )
}

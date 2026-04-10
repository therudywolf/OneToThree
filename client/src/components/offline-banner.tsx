'use client'

import { useWebSocketNetwork } from '@/hooks/use-websocket-network'

export function OfflineBanner() {
  const { online, wsConnected, queuedCount } = useWebSocketNetwork()

  if (online && wsConnected && queuedCount === 0) return null

  return (
    <div className="animate-pulse border-b border-neon-red bg-red-950/80 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red">
      {!online
        ? ':: NETWORK_OFFLINE — NO_UPLINK'
        : wsConnected
          ? `:: RECOVERING_QUEUE — ${queuedCount} PENDING`
          : ':: SOCKET_DISCONNECTED — RECONNECTING…'}
    </div>
  )
}

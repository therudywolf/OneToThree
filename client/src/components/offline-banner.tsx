'use client'

import { useWebSocketNetwork } from '@/hooks/use-websocket-network'

export function OfflineBanner() {
  const { is_online, is_linked, buffer_depth } = useWebSocketNetwork()

  if (is_online && is_linked && buffer_depth === 0) return null

  return (
    <div className="animate-pulse border-b border-neon-red bg-red-950/80 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red">
      {!is_online
        ? ':: NETWORK_OFFLINE — NO_UPLINK'
        : is_linked
          ? `:: RECOVERING_QUEUE — ${buffer_depth} PENDING`
          : ':: SOCKET_DISCONNECTED — RECONNECTING…'}
    </div>
  )
}

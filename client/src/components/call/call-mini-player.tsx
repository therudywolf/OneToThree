'use client'

import { useEffect, useState } from 'react'
import { useCallStore } from '@/store/callStore'
import { useTranslation } from '@/hooks/use-translation'
import { FloatingCallWindow } from '@/components/call/call-floating-window'

type Props = {
  onExpand: () => void
  onEndCall: () => void
  onToggleMute: () => void
  peerName?: string
}

/**
 * Minimized 1:1 call — a draggable floating window with the peer's live video
 * (see FloatingCallWindow). Replaces the old 40px chip that vanished under
 * other UI.
 */
export function CallMiniPlayer({ onExpand, onEndCall, onToggleMute, peerName }: Props) {
  const { t } = useTranslation()
  const isCalling = useCallStore((s) => s.isCalling)
  const isMiniPlayer = useCallStore((s) => s.isMiniPlayer)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)
  const callStartTime = useCallStore((s) => s.callStartTime)

  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!callStartTime) { setElapsed(0); return }
    const id = window.setInterval(() => setElapsed(Date.now() - callStartTime), 500)
    return () => window.clearInterval(id)
  }, [callStartTime])

  if (!isCalling || !isMiniPlayer) return null

  const audioMuted = localStream?.getAudioTracks().some((t_) => !t_.enabled) ?? false
  const firstRemote = Object.values(remoteStreams)[0] ?? null

  return (
    <FloatingCallWindow
      stream={firstRemote}
      title={peerName || t('call.activePeer')}
      elapsedMs={elapsed}
      micMuted={audioMuted}
      onExpand={onExpand}
      onToggleMute={onToggleMute}
      onEndCall={onEndCall}
    />
  )
}

'use client'

import { useEffect, useState } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { motion } from 'framer-motion'
import { useCallStore } from '@/store/callStore'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  onExpand: () => void
  onEndCall: () => void
  onToggleMute: () => void
  peerName?: string
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * PROJECT 13 :: CALL_MINI_PLAYER
 * Floating pill shown when navigating away from an active 1v1 call.
 */
export function CallMiniPlayer({ onExpand, onEndCall, onToggleMute, peerName }: Props) {
  const { t } = useTranslation()
  const isCalling = useCallStore((s) => s.isCalling)
  const isMiniPlayer = useCallStore((s) => s.isMiniPlayer)
  const localStream = useCallStore((s) => s.localStream)
  const callStartTime = useCallStore((s) => s.callStartTime)

  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!callStartTime) { setElapsed(0); return }
    const id = window.setInterval(() => setElapsed(Date.now() - callStartTime), 500)
    return () => window.clearInterval(id)
  }, [callStartTime])

  if (!isCalling || !isMiniPlayer) return null

  const audioMuted = localStream?.getAudioTracks().some((t) => !t.enabled) ?? false
  const displayName = peerName || t('call.activePeer')

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed bottom-24 right-4 z-[190] flex items-center gap-2 bg-void/95 border border-border-strong backdrop-blur-xl shadow-2xl px-3 py-2 cursor-pointer"
      onClick={onExpand}
    >
      {/* Avatar placeholder */}
      <div className="h-7 w-7 rounded-full border-2 border-neon-cyan/50 bg-void flex items-center justify-center flex-shrink-0">
        <span className="font-mono text-[8px] uppercase text-neon-cyan">
          {displayName.slice(0, 2)}
        </span>
      </div>

      {/* Name + timer */}
      <div className="flex flex-col min-w-0">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-primary truncate max-w-[80px]">
          {displayName}
        </span>
        <span className="font-mono text-[9px] text-neon-cyan/70 tracking-wider">
          {formatDuration(elapsed)}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 pl-1 border-l border-border-strong ml-1">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMute() }}
          className={`p-1.5 transition-colors ${audioMuted ? 'text-neon-red' : 'text-text-muted hover:text-text-primary'}`}
          title={audioMuted ? t('call.unmute') : t('call.mute')}
        >
          {audioMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onEndCall() }}
          className="p-1.5 text-neon-red hover:bg-neon-red/20 transition-colors"
          title={t('call.endCall')}
        >
          <PhoneOff className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

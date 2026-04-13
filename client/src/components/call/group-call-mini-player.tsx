'use client'

import { Mic, MicOff, PhoneOff, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  onExpand: () => void
  onEndCall: () => void
  onToggleMute: () => void
}

/**
 * PROJECT 13 :: GROUP_CALL_MINI_PLAYER
 * Floating pill shown when navigating away from an active group call.
 */
export function GroupCallMiniPlayer({ onExpand, onEndCall, onToggleMute }: Props) {
  const { t } = useTranslation()
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const isMiniPlayer = useGroupCallStore((s) => s.isMiniPlayer)
  const participants = useGroupCallStore((s) => s.participants)
  const localStream = useGroupCallStore((s) => s.localStream)

  if (!isInGroupCall || !isMiniPlayer) return null

  const totalCount = Object.keys(participants).length + 1
  const audioMuted = localStream?.getAudioTracks().some((t) => !t.enabled) ?? false

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed bottom-24 right-4 z-[190] flex items-center gap-2 bg-black/95 border border-neutral-700 backdrop-blur-xl shadow-2xl px-3 py-2 cursor-pointer"
      onClick={onExpand}
    >
      {/* Participant avatars (up to 4) */}
      <div className="flex -space-x-2">
        {Object.values(participants)
          .slice(0, 4)
          .map((p) => (
            <div
              key={p.userId}
              className={`h-7 w-7 rounded-full border-2 border-black flex items-center justify-center ${
                p.isSpeaking
                  ? 'bg-neon-cyan/20 border-neon-cyan/50'
                  : 'bg-neutral-900 border-neutral-700'
              }`}
            >
              <span className="font-mono text-[8px] uppercase text-neutral-400">
                {p.username.slice(0, 2)}
              </span>
            </div>
          ))}
      </div>

      {/* Count badge */}
      <div className="flex items-center gap-1 pl-1">
        <Users className="h-3 w-3 text-neon-cyan" />
        <span className="font-mono text-[10px] text-neon-cyan">{totalCount}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 pl-1 border-l border-neutral-800 ml-1">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleMute()
          }}
          className={`p-1.5 transition-colors ${
            audioMuted ? 'text-neon-red' : 'text-neutral-400 hover:text-white'
          }`}
          title={audioMuted ? t('call.unmute') : t('call.mute')}
        >
          {audioMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEndCall()
          }}
          className="p-1.5 text-neon-red hover:bg-neon-red/20 transition-colors"
          title={t('call.endCall')}
        >
          <PhoneOff className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

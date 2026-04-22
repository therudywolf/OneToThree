'use client'

import { Mic, MicOff, PhoneOff, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  onExpand: () => void
  onEndCall: () => void
  onToggleMute: () => void
}

export function GroupCallMiniPlayer({ onExpand, onEndCall, onToggleMute }: Props) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
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
      className={`fixed bottom-24 right-4 z-[190] flex items-center gap-2 backdrop-blur-xl shadow-2xl px-3 py-2 cursor-pointer ${
        isMd3
          ? 'rounded-[28px] bg-[var(--surface-container-high)] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
          : 'bg-void/95 border border-border-strong'
      }`}
      onClick={onExpand}
    >
      <div className="flex -space-x-2">
        {Object.values(participants)
          .slice(0, 4)
          .map((p) => (
            <div
              key={p.userId}
              className={`h-7 w-7 rounded-full border-2 flex items-center justify-center ${
                p.isSpeaking
                  ? isMd3
                    ? 'bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] border-[var(--primary)]'
                    : 'bg-neon-cyan/20 border-neon-cyan/50'
                  : isMd3
                    ? 'bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] border-[color-mix(in_srgb,var(--on-surface)_15%,transparent)]'
                    : 'bg-void border-border-strong'
              }`}
            >
              <span className={`text-[8px] uppercase ${isMd3 ? 'font-sans font-semibold text-[var(--on-surface-variant)]' : 'font-mono text-text-muted'}`}>
                {p.username.slice(0, 2)}
              </span>
            </div>
          ))}
      </div>

      <div className="flex items-center gap-1 pl-1">
        <Users className={`h-3 w-3 ${isMd3 ? 'text-[var(--primary)]' : 'text-neon-cyan'}`} />
        <span className={`text-[10px] ${isMd3 ? 'font-sans text-[var(--primary)]' : 'font-mono text-neon-cyan'}`}>{totalCount}</span>
      </div>

      <div className={`flex items-center gap-1 pl-1 ml-1 ${isMd3 ? '' : 'border-l border-border-strong'}`}>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMute() }}
          className={`p-1.5 rounded-full transition-colors ${audioMuted ? (isMd3 ? 'text-[var(--error)]' : 'text-neon-red') : 'text-text-muted hover:text-text-primary'}`}
          title={audioMuted ? t('call.unmute') : t('call.mute')}
        >
          {audioMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onEndCall() }}
          className={`p-1.5 rounded-full transition-colors ${isMd3 ? 'text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_15%,transparent)]' : 'text-neon-red hover:bg-neon-red/20'}`}
          title={t('call.endCall')}
        >
          <PhoneOff className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

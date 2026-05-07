'use client'

import { Phone, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

type Props = {
  participantCount: number
  onJoinVoice: () => void
  onJoinVideo: () => void
}

/**
 * PROJECT 13 :: GROUP_CALL_ACTIVE_BANNER
 * Displayed in the group chat header area when a group call is active.
 */
export function GroupCallBanner({ participantCount, onJoinVoice, onJoinVideo }: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div className={`p13-group-call-banner flex items-center justify-between border-b px-4 py-2 ${
        isRetro ? 'p13-classic-strip border-b-0' : 'border-neon-cyan/20 bg-neon-cyan/5'
      }`}>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full opacity-75 ${isRetro ? 'p13-classic-accent-fill' : 'animate-ping bg-neon-cyan'}`} />
            <span className={`relative inline-flex h-2 w-2 ${isRetro ? 'p13-classic-accent-fill' : 'bg-neon-cyan'}`} />
          </span>
          <span className={`text-[10px] ${isRetro ? 'p13-classic-copy-strong' : isMd3 ? 'text-[var(--primary)] font-medium' : 'font-mono uppercase tracking-wider text-neon-cyan'}`}>
            {t('groupCall.activeCall')}
          </span>
          <span className={`flex items-center gap-1 ${isMd3 ? '' : 'font-mono '}text-[10px] text-text-muted`}>
            <Users className="h-3 w-3" />
            {participantCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onJoinVoice}
            className={`flex items-center gap-1.5 border px-3 py-1 text-[10px] transition-colors ${
              isRetro
                ? 'p13-classic-button'
                : isMd3 ? 'rounded-full border-[var(--primary)]/50 bg-[var(--primary-container)] text-[var(--on-primary-container)] hover:bg-[var(--primary-container)]/80'
                : 'border-neon-cyan/50 bg-neon-cyan/10 font-mono uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan/20'
            }`}
          >
            <Phone className="h-3 w-3" />
            {t('groupCall.joinVoice')}
          </button>
          <button
            onClick={onJoinVideo}
            className={`flex items-center gap-1.5 border px-3 py-1 text-[10px] transition-colors ${
              isRetro
                ? 'p13-classic-button p13-classic-button--danger'
                : isMd3 ? 'rounded-full border-[var(--error)]/50 bg-[var(--error-container)] text-[var(--on-error-container)] hover:opacity-90'
                : 'border-neon-red/50 bg-neon-red/10 font-mono uppercase tracking-wider text-neon-red hover:bg-neon-red/20'
            }`}
          >
            {t('groupCall.joinVideo')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

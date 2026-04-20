'use client'

import { Phone, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from '@/hooks/use-translation'

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

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-neon-cyan/20 bg-neon-cyan/5 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full bg-neon-cyan opacity-75" />
            <span className="relative inline-flex h-2 w-2 bg-neon-cyan" />
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-neon-cyan">
            {t('groupCall.activeCall')}
          </span>
          <span className="flex items-center gap-1 font-mono text-[10px] text-text-muted">
            <Users className="h-3 w-3" />
            {participantCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onJoinVoice}
            className="flex items-center gap-1.5 border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan/20 transition-colors"
          >
            <Phone className="h-3 w-3" />
            {t('groupCall.joinVoice')}
          </button>
          <button
            onClick={onJoinVideo}
            className="flex items-center gap-1.5 border border-neon-red/50 bg-neon-red/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neon-red hover:bg-neon-red/20 transition-colors"
          >
            {t('groupCall.joinVideo')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

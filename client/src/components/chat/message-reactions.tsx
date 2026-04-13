'use client'

import { SmilePlus } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  reactions: Record<string, string[]>
  currentUserId: string
  onToggleReaction: (emoji: string) => void
  onOpenPicker: () => void
}

export function MessageReactions({
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenPicker,
}: Props) {
  const { t } = useTranslation()
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0)

  if (entries.length === 0) return null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, userIds]) => {
        const isMine = userIds.includes(currentUserId)
        return (
          <button
            key={emoji}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleReaction(emoji)
            }}
            className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] transition-all active:scale-95 ${
              isMine
                ? 'border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan'
                : 'border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:border-neon-cyan/40'
            }`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            <span className="tabular-nums">{userIds.length}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenPicker()
        }}
        className="inline-flex h-6 w-6 items-center justify-center border border-zinc-800 bg-zinc-950 text-zinc-500 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
        title={t('reactions.add')}
      >
        <SmilePlus className="h-3 w-3" />
      </button>
    </div>
  )
}

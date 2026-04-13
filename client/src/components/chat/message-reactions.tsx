'use client'

import { useState } from 'react'
import { SmilePlus } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from '@/hooks/use-translation'

const RECENTLY_USED_KEY = 'p13_recent_reactions'
const QUICK_EMOJIS = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F44E}', '\u{1F525}', '\u{1F64F}', '\u{1F60D}']

function getRecentlyUsed(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(RECENTLY_USED_KEY)
    return raw ? (JSON.parse(raw) as string[]).slice(0, 8) : []
  } catch {
    return []
  }
}

function addRecentlyUsed(emoji: string) {
  try {
    const current = getRecentlyUsed()
    const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, 8)
    localStorage.setItem(RECENTLY_USED_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
}

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0)

  if (entries.length === 0) return null

  const recentEmojis = getRecentlyUsed()
  const pickerEmojis = recentEmojis.length > 0
    ? [...new Set([...recentEmojis, ...QUICK_EMOJIS])].slice(0, 12)
    : QUICK_EMOJIS

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, userIds]) => {
        const isMine = userIds.includes(currentUserId)
        return (
          <motion.button
            key={emoji}
            type="button"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.15 }}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              onToggleReaction(emoji)
              addRecentlyUsed(emoji)
            }}
            className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] transition-all active:scale-95 ${
              isMine
                ? 'border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan shadow-[0_0_6px_rgba(0,255,255,0.15)]'
                : 'border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:border-neon-cyan/40'
            }`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            <span className="tabular-nums">{userIds.length}</span>
          </motion.button>
        )
      })}
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setPickerOpen((o) => !o)
            onOpenPicker()
          }}
          className="inline-flex h-6 w-6 items-center justify-center border border-zinc-800 bg-zinc-950 text-zinc-500 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
          title={t('reactions.add')}
        >
          <SmilePlus className="h-3 w-3" />
        </button>
        <AnimatePresence>
          {pickerOpen ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-full left-0 z-20 mb-1 flex flex-wrap gap-0.5 border border-neon-cyan/40 bg-black p-1.5 shadow-[0_0_16px_rgba(0,255,255,0.1)]"
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {recentEmojis.length > 0 ? (
                <p className="w-full font-mono text-[7px] uppercase tracking-widest text-zinc-600 mb-0.5">
                  {t('reactions.recentlyUsed')}
                </p>
              ) : null}
              {pickerEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleReaction(emoji)
                    addRecentlyUsed(emoji)
                    setPickerOpen(false)
                  }}
                  className="flex h-7 w-7 items-center justify-center text-base transition-transform hover:scale-125 active:scale-95"
                >
                  {emoji}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

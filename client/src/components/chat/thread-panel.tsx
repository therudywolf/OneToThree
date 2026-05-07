'use client'

import { useMemo } from 'react'
import { CornerDownRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import type { DecryptedMessage } from '@/types/chat'
import { NoirPlaintext } from '@/components/chat/noir-plaintext'
import { formatMessageTimestamp } from '@/lib/timestamp-format'

type Props = {
  rootMessage: DecryptedMessage
  allMessages: DecryptedMessage[]
  currentUserId: string
  onClose: () => void
  onReply: (msg: DecryptedMessage) => void
  locale: 'ru' | 'en'
  labelForSender: (id: string) => string
}

export function ThreadPanel({
  rootMessage,
  allMessages,
  currentUserId,
  onClose,
  onReply,
  locale,
  labelForSender,
}: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  const threadMessages = useMemo(() => {
    return allMessages
      .filter((m) => m.id === rootMessage.id || m.reply_to_id === rootMessage.id)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  }, [allMessages, rootMessage.id])

  return (
    <AnimatePresence>
      <motion.div
        key="thread-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className={`absolute inset-y-0 right-0 z-[115] flex w-full max-w-sm flex-col shadow-[-8px_0_24px_rgba(0,0,0,0.5)] ${
          isMd3
            ? 'border-l border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
            : 'border-l border-neon-cyan/30 bg-void'
        }`}
      >
        {/* Header */}
        <header className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 ${
          isMd3
            ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
            : 'border-neon-cyan/30'
        }`}>
          <div className="flex items-center gap-2">
            <CornerDownRight className={`h-3.5 w-3.5 shrink-0 ${isMd3 ? 'text-[var(--on-surface-variant)]' : 'text-neon-cyan/60'}`} />
            <p className={`text-[10px] uppercase tracking-widest ${isMd3 ? 'font-sans text-[var(--on-surface)]' : 'font-mono text-neon-cyan'}`}>
              {t('thread.title')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`text-xs transition-colors ${
              isMd3
                ? 'rounded-full p-1 text-[var(--on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'font-mono text-neon-red hover:text-neon-cyan'
            }`}
          >
            {isMd3 ? '✕' : '[X]'}
          </button>
        </header>

        {/* Messages */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {threadMessages.length === 0 ? (
            <p className={`py-6 text-center text-[9px] text-text-muted/70 ${isMd3 ? '' : 'font-mono'}`}>{t('thread.noReplies')}</p>
          ) : (
            threadMessages.map((m) => {
              const mine = m.sender_id === currentUserId
              const isRoot = m.id === rootMessage.id
              return (
                <div
                  key={m.id}
                  className={`flex flex-col gap-0.5 ${
                    mine ? 'items-end' : 'items-start'
                  } ${isRoot ? 'opacity-70' : ''}`}
                >
                  <span className={`text-[9px] ${isMd3 ? 'text-text-muted' : 'font-mono text-neon-cyan/60'}`}>
                    {labelForSender(m.sender_id)}
                    {isRoot ? ` · ${t('thread.title')}` : ''}
                  </span>
                  <div className={`max-w-[85%] border px-2.5 py-1.5 text-[10px] ${
                    isMd3
                      ? mine
                        ? 'rounded-[14px_14px_4px_14px] border-[color-mix(in_srgb,var(--primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--on-surface)]'
                        : 'rounded-[14px_14px_14px_4px] border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)] text-[var(--on-surface)]'
                      : mine
                        ? 'border-neon-cyan/40 bg-neon-cyan/10 font-mono text-neon-cyan'
                        : 'border-neon-cyan/20 bg-void font-mono text-neon-red'
                  }`}>
                    {m.plaintext && (
                      <NoirPlaintext text={m.plaintext} className="break-words whitespace-pre-wrap" />
                    )}
                    {!m.plaintext && m.media_path && (
                      <span className="text-text-muted">[MEDIA]</span>
                    )}
                  </div>
                  <span className={`text-[8px] text-text-muted/70 ${isMd3 ? '' : 'font-mono'}`}>
                    {formatMessageTimestamp(m.created_at, locale)}
                  </span>
                </div>
              )
            })
          )}
        </div>

        {/* Reply button */}
        <div className={`shrink-0 border-t p-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'border-neon-cyan/20'}`}>
          <button
            type="button"
            onClick={() => { onReply(rootMessage); onClose() }}
            className={`w-full py-2 text-[10px] uppercase tracking-widest transition-colors ${
              isMd3
                ? 'rounded-full bg-[var(--primary)] py-2.5 text-[var(--on-primary)] hover:opacity-90'
                : 'border border-neon-cyan bg-void font-mono text-neon-cyan hover:bg-neon-cyan/10'
            }`}
          >
            {isMd3 ? t('thread.reply') : `[ ${t('thread.reply')} ]`}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

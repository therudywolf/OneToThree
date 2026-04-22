'use client'

import { useMemo } from 'react'
import { CornerDownRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from '@/hooks/use-translation'
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
        className="absolute inset-y-0 right-0 z-[115] flex w-full max-w-sm flex-col border-l border-neon-cyan/30 bg-void shadow-[-8px_0_24px_rgba(0,0,0,0.5)]"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-neon-cyan/30 px-3 py-2">
          <div className="flex items-center gap-2">
            <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-neon-cyan/60" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
              {t('thread.title')}
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="font-mono text-xs text-neon-red hover:text-neon-cyan">[X]</button>
        </header>

        {/* Messages */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {threadMessages.length === 0 ? (
            <p className="text-center font-mono text-[9px] text-text-muted/70 py-6">{t('thread.noReplies')}</p>
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
                  <span className="font-mono text-[9px] text-neon-cyan/60">
                    {labelForSender(m.sender_id)}
                    {isRoot ? ` · ${t('thread.title')}` : ''}
                  </span>
                  <div className={`max-w-[85%] border px-2.5 py-1.5 font-mono text-[10px] ${
                    mine
                      ? 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan'
                      : 'border-neon-cyan/20 bg-void text-neon-red'
                  }`}>
                    {m.plaintext && (
                      <NoirPlaintext text={m.plaintext} className="break-words whitespace-pre-wrap" />
                    )}
                    {!m.plaintext && m.media_path && (
                      <span className="text-text-muted">[MEDIA]</span>
                    )}
                  </div>
                  <span className="font-mono text-[8px] text-text-muted/70">
                    {formatMessageTimestamp(m.created_at, locale)}
                  </span>
                </div>
              )
            })
          )}
        </div>

        {/* Reply button */}
        <div className="shrink-0 border-t border-neon-cyan/20 p-3">
          <button type="button"
            onClick={() => { onReply(rootMessage); onClose() }}
            className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
            [ {t('thread.reply')} ]
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

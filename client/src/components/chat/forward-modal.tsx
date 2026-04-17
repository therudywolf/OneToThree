'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { fetchChatsList, type ApiChatRow } from '@/lib/api/chats'
import type { DecryptedMessage } from '@/types/chat'

type Props = {
  message: DecryptedMessage
  onClose: () => void
  /** sendText(text, replyTo, opts) — same signature as ChatTerminal.sendText */
  onForward: (chatId: string, text: string) => Promise<void>
}

export function ForwardModal({ message, onClose, onForward }: Props) {
  const { t } = useTranslation()
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchChatsList()
      .then((list) => setChats(list))
      .catch(() => setError('LOAD_FAILED'))
      .finally(() => setLoading(false))
  }, [])

  const text = message.plaintext ?? ''

  const filtered = chats.filter((c) => {
    const name = (c.name ?? c.id).toLowerCase()
    return name.includes(search.toLowerCase())
  })

  const handleForward = useCallback(async (chatId: string) => {
    if (busy || !text.trim()) return
    setBusy(chatId)
    setError(null)
    try {
      await onForward(chatId, text)
      setSent((prev) => new Set([...prev, chatId]))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('forward.failed'))
    } finally {
      setBusy(null)
    }
  }, [busy, text, onForward, t])

  return (
    <AnimatePresence>
      <motion.div
        key="forward-modal"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 px-3"
      >
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className="terminal-panel w-full max-w-sm"
        >
          <header className="flex items-center justify-between gap-2 border-b border-neon-cyan/30 pb-3 mb-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
              {t('forward.title')}
            </p>
            <button type="button" onClick={onClose}
              className="text-neon-red font-mono text-xs hover:text-neon-cyan">[X]</button>
          </header>

          {/* Snippet preview */}
          {text.trim() && (
            <div className="mb-3 border border-neon-cyan/20 px-2 py-1.5">
              <p className="font-mono text-[9px] text-neon-cyan/60 truncate">
                {text.slice(0, 120)}{text.length > 120 ? '…' : ''}
              </p>
            </div>
          )}

          <input
            className="terminal-input mb-3 text-[10px]"
            placeholder={t('forward.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {loading ? (
            <p className="text-center font-mono text-[9px] text-neon-cyan/50 py-4">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <p className="text-center font-mono text-[9px] text-zinc-600 py-4">{t('forward.noChats')}</p>
          ) : (
            <div className="max-h-52 space-y-1 overflow-y-auto">
              {filtered.map((c) => {
                const isSent = sent.has(c.id)
                const isBusy = busy === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={!!busy || isSent}
                    onClick={() => void handleForward(c.id)}
                    className={`flex w-full items-center justify-between border px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      isSent
                        ? 'border-neon-cyan/20 text-neon-cyan/40'
                        : 'border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/10'
                    } disabled:opacity-50`}
                  >
                    <span className="truncate">{c.name ?? c.id.slice(0, 12)}</span>
                    {isBusy ? (
                      <span className="animate-pulse text-[8px]">…</span>
                    ) : isSent ? (
                      <span className="text-[8px] text-neon-cyan">{t('forward.success')}</span>
                    ) : (
                      <Send className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {error && (
            <p className="mt-2 font-mono text-[9px] text-neon-red">[!] {error}</p>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

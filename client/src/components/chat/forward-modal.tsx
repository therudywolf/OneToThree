'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
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
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchChatsList()
      .then((list) => setChats(list))
      .catch(() => setError(t('settings.loadFailed')))
      .finally(() => setLoading(false))
  }, [t])

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
    } catch {
      setError(t('forward.failed'))
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
        className={`fixed inset-0 z-[130] flex items-center justify-center px-3 ${
          isMd3
            ? 'bg-[color-mix(in_srgb,var(--void)_40%,transparent)] backdrop-blur-sm'
            : isRetro
              ? 'p13-classic-overlay'
              : 'bg-void/80'
        }`}
      >
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className={`w-full max-w-sm ${
            isMd3
              ? 'rounded-[28px] bg-[var(--surface-container-high)] p-5 shadow-[var(--md3-elevation-3)]'
            : isRetro
                ? 'p13-classic-window p-0'
                : 'terminal-panel'
          }`}
        >
          <header className={`flex items-center justify-between gap-2 ${isRetro ? 'mb-0 p13-classic-titlebar px-3 py-2' : 'mb-3 pb-3 border-b'} ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : isRetro ? '' : 'border-neon-cyan/30'}`}>
            <p className={`text-[10px] ${isMd3 ? 'font-sans font-semibold text-[var(--on-surface)]' : isRetro ? 'tracking-[0.05em]' : 'font-mono uppercase tracking-widest text-neon-cyan'}`}>
              {t('forward.title')}
            </p>
            <button
              type="button"
              onClick={onClose}
              className={`inline-flex h-8 w-8 items-center justify-center transition-colors ${
                isMd3
                  ? 'rounded-full text-[var(--on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                  : isRetro
                    ? 'p13-classic-button'
                    : 'border border-neon-red/35 bg-void text-neon-red hover:border-neon-cyan hover:text-neon-cyan'
              }`}
            >
              <span className={`${isMd3 ? 'font-sans' : isRetro ? '' : 'font-mono'} text-[10px] leading-none`}>✕</span>
            </button>
          </header>
          <div className={isRetro ? 'p-4' : ''}>

          {/* Snippet preview */}
          {text.trim() && (
            <div className={`mb-3 px-2 py-1.5 ${isMd3 ? 'rounded-xl bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : isRetro ? 'p13-classic-inset' : 'border border-neon-cyan/20'}`}>
              <p className={`text-[9px] truncate ${isMd3 ? 'text-[var(--on-surface-variant)]' : isRetro ? 'p13-classic-copy-soft' : 'font-mono text-neon-cyan/60'}`}>
                {text.slice(0, 120)}{text.length > 120 ? '…' : ''}
              </p>
            </div>
          )}

          <input
            className={`mb-3 h-10 w-full px-3 text-[10px] ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] placeholder:text-text-muted focus:outline-none' : isRetro ? 'p13-classic-input outline-none' : 'terminal-input'}`}
            placeholder={t('forward.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {loading ? (
            <p className={`text-center text-[9px] py-4 ${isMd3 ? 'text-[var(--on-surface-variant)]' : 'font-mono text-neon-cyan/50'}`}>{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <p className={`text-center text-[9px] text-text-muted/70 py-4 ${isMd3 ? '' : 'font-mono'}`}>{t('forward.noChats')}</p>
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
                    className={`flex h-10 w-full items-center justify-between px-3 text-[10px] transition-colors disabled:opacity-50 ${
                      isMd3
                        ? `rounded-xl ${isSent ? 'bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-[color-mix(in_srgb,var(--primary)_50%,var(--on-surface))]' : 'text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]'}`
                        : isRetro
                          ? `border ${isSent ? 'p13-classic-button p13-classic-button--muted' : 'p13-classic-button'}`
                          : `border font-mono uppercase tracking-widest ${isSent ? 'border-neon-cyan/20 text-neon-cyan/40' : 'border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/10'}`
                    }`}
                  >
                    <span className="truncate">{c.name ?? c.id.slice(0, 12)}</span>
                    {isBusy ? (
                      <span className="animate-pulse text-[8px]">…</span>
                    ) : isSent ? (
                      <span className={`text-[8px] ${isMd3 ? 'text-[var(--primary)]' : 'text-neon-cyan'}`}>{t('forward.success')}</span>
                    ) : (
                      <Send className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {error && (
            <p className={`mt-2 text-[9px] ${isMd3 ? 'text-[var(--danger)]' : 'font-mono text-neon-red'}`}>[!] {error}</p>
          )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useLocalSearch } from '@/hooks/use-local-search'
import { useTranslation } from '@/hooks/use-translation'
import { useShell } from '@/components/ui/shell'
import { useLocaleStore } from '@/store/localeStore'
import { formatMessageTimestamp } from '@/lib/timestamp-format'

type Props = {
  /** Scroll/highlight callback — wired by chat-terminal via ref. */
  onJumpToMessage?: (messageId: string) => void
  onClose?: () => void
  /** Optional override; falls back to `useLocaleStore().module`. */
  locale?: string
}

/**
 * Per-chat search panel. Hosted inside the right-side dock on xl+ screens and
 * as an inline overlay on narrower viewports. Runs entirely in-browser against
 * the already-decrypted `chatStore.messages` — plaintext never leaves the
 * device.
 */
export function ChatSearchPanel({ onJumpToMessage, onClose, locale }: Props) {
  const { t } = useTranslation()
  const { isTerminal } = useShell()
  const localeFromStore = useLocaleStore((s) => s.module)
  const effectiveLocale: 'en' | 'ru' =
    (locale ?? localeFromStore) === 'ru' ? 'ru' : 'en'
  const inputRef = useRef<HTMLInputElement>(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const { query, results, search, clear } = useLocalSearch()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 120)
    return () => clearTimeout(h)
  }, [query])

  const handleJump = useCallback(
    (messageId: string) => {
      if (onJumpToMessage) onJumpToMessage(messageId)
    },
    [onJumpToMessage]
  )

  const highlighted = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return results
    return results
  }, [debouncedQuery, results])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center gap-2 px-3 py-2 ${
          isTerminal
            ? 'border-b border-neon-cyan/30'
            : 'border-b border-[var(--md3-outline-variant,rgba(255,255,255,0.08))]'
        }`}
      >
        <Search className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder={t('chatSearch.placeholder')}
          className={`min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-50 ${
            isTerminal
              ? 'font-mono uppercase tracking-widest text-neon-cyan'
              : 'text-[var(--md3-on-surface,#fff)]'
          }`}
          type="search"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            onClick={clear}
            aria-label={t('common.clear')}
            className="opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {debouncedQuery.trim().length < 2 ? (
          <p
            className={`p-3 text-[11px] opacity-60 ${
              isTerminal ? 'font-mono uppercase tracking-widest text-neon-cyan/60' : ''
            }`}
          >
            {t('chatSearch.hint')}
          </p>
        ) : highlighted.length === 0 ? (
          <p
            className={`p-3 text-[11px] opacity-60 ${
              isTerminal ? 'font-mono uppercase tracking-widest text-neon-cyan/60' : ''
            }`}
          >
            {t('chatSearch.empty')}
          </p>
        ) : (
          <ul className="space-y-1 p-2">
            {highlighted.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => handleJump(m.id)}
                  className={`block w-full text-left text-[11px] transition-colors ${
                    isTerminal
                      ? 'border border-neon-cyan/20 bg-void/40 px-2 py-1 font-mono text-neon-cyan/90 hover:border-neon-cyan/50 hover:bg-neon-cyan/10'
                      : 'rounded-[var(--radius-sm,8px)] bg-[color-mix(in_srgb,var(--md3-primary,#8ab4f8)_8%,transparent)] px-2 py-1.5 text-[var(--md3-on-surface,#fff)] hover:bg-[color-mix(in_srgb,var(--md3-primary,#8ab4f8)_14%,transparent)]'
                  }`}
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2 text-[9px] uppercase tracking-widest opacity-60">
                    <span className="truncate">
                      {formatMessageTimestamp(m.created_at, effectiveLocale)}
                    </span>
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap break-words">
                    {highlightMatch(m.plaintext ?? '', debouncedQuery)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Wrap substrings matching `query` in <mark>. Returns a React fragment so the
 * caller can render it inside an arbitrary parent.
 */
function highlightMatch(text: string, query: string) {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: React.ReactNode[] = []
  let idx = 0
  while (idx < text.length) {
    const hit = lower.indexOf(needle, idx)
    if (hit === -1) {
      parts.push(text.slice(idx))
      break
    }
    if (hit > idx) parts.push(text.slice(idx, hit))
    parts.push(
      <mark
        key={hit}
        className="bg-[color-mix(in_srgb,var(--neon-cyan,#22d3ee)_28%,transparent)] text-inherit"
      >
        {text.slice(hit, hit + needle.length)}
      </mark>
    )
    idx = hit + needle.length
  }
  return <>{parts}</>
}

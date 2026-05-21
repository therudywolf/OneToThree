'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, X, Users, Megaphone, Loader2 } from 'lucide-react'
import { discoverChats, type DiscoverChatRow } from '@/lib/api/chats'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

type ExploreModalProps = {
  onJoin: (inviteCode: string) => void
  onClose: () => void
}

export function ExploreModal({ onJoin, onClose }: ExploreModalProps) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode) === 'md3'
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<DiscoverChatRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // ESC-to-close + Tab focus trap + body scroll lock, matching every other dialog.
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)

  const load = useCallback(async (query: string) => {
    setLoading(true)
    setErr(null)
    try {
      const data = await discoverChats({ q: query || undefined, limit: 30 })
      setRows(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ERR')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  useEffect(() => {
    const tm = window.setTimeout(() => { void load(q) }, 300)
    return () => window.clearTimeout(tm)
  }, [q, load])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-void/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('explore.title')}
        className={`relative z-10 flex w-full max-w-md flex-col overflow-hidden ${
          isMd3
            ? 'rounded-3xl bg-[var(--surface-container-high)] shadow-[var(--md3-elevation-5)]'
            : 'border border-neon-cyan/40 bg-void shadow-[0_0_40px_rgba(0,255,255,0.08)]'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 ${isMd3 ? 'border-b border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]' : 'border-b border-neon-cyan/20'}`}>
          <span className={`font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono text-[11px] uppercase tracking-widest text-neon-cyan'}`}>
            {t('explore.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className={`p13-icon-btn h-8 w-8 ${isMd3 ? 'rounded-full' : ''}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className={`p-3 ${isMd3 ? 'border-b border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]' : 'border-b border-neon-cyan/10'}`}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted/60" />
            <input
              className={`h-9 w-full pl-9 pr-3 text-[12px] ${
                isMd3
                  ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] placeholder:text-text-muted focus:outline-none'
                  : 'border border-neon-cyan/20 bg-void font-mono text-neon-cyan placeholder:text-neon-cyan/30 focus:border-neon-cyan/50 focus:outline-none'
              }`}
              placeholder={t('explore.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        {/* Results */}
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          ) : err ? (
            <p className="p-4 text-center text-[11px] text-neon-red">{err}</p>
          ) : rows.length === 0 ? (
            <p className={`p-6 text-center text-[11px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-widest text-text-muted/60'}`}>
              {t('explore.noResults')}
            </p>
          ) : (
            rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                  isMd3
                    ? 'hover:bg-[var(--state-hover)]'
                    : 'border-b border-neon-cyan/10 hover:bg-neon-cyan/5'
                }`}
                onClick={() => row.invite_code && onJoin(row.invite_code)}
                disabled={!row.invite_code}
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center ${
                  isMd3
                    ? 'rounded-full bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] text-[var(--primary)]'
                    : 'border border-neon-cyan/40 bg-void text-neon-cyan'
                }`}>
                  {row.type === 'channel'
                    ? <Megaphone className="h-4 w-4" />
                    : <Users className="h-4 w-4" />
                  }
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`truncate font-medium ${isMd3 ? 'text-sm text-[var(--on-surface)]' : 'text-[12px] text-neon-cyan/90'}`}>
                    {row.name ?? t('sidebar.groupUntitled')}
                  </p>
                  <p className={`text-[10px] ${isMd3 ? 'text-text-muted' : 'font-mono text-text-muted/60'}`}>
                    {row.member_count.toLocaleString()} {t('sidebar.members')} · {row.type === 'channel' ? t('explore.typeChannel') : t('explore.typeGroup')}
                  </p>
                </div>
                <span className={`shrink-0 text-[10px] ${isMd3 ? 'text-[var(--primary)]' : 'font-mono uppercase tracking-widest text-neon-cyan'}`}>
                  {t('explore.join')}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import { fetchStickerPacks, deleteStickerPack, refreshStickerPack, type StickerPack } from '@/lib/api/stickers'
import { toastError } from '@/store/toastStore'

export function SettingsStickersPanel() {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setPacks(await fetchStickerPacks())
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'LOAD_FAILED'
      setLoadError(msg)
      toastError(msg, { title: 'Stickers' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleDelete = async (pack: StickerPack) => {
    if (deletingId) return
    setDeletingId(pack.id)
    try {
      await deleteStickerPack(pack.id)
      setPacks((prev) => prev.filter((p) => p.id !== pack.id))
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'DELETE_FAILED', { title: 'Stickers' })
    } finally {
      setDeletingId(null)
    }
  }

  const handleRefresh = async (pack: StickerPack) => {
    if (refreshingId) return
    setRefreshingId(pack.id)
    try {
      const res = await refreshStickerPack(pack.id)
      toastError(`✓ Refreshed: ${res.count} stickers`, { title: pack.title })
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'REFRESH_FAILED', { title: 'Stickers' })
    } finally {
      setRefreshingId(null)
    }
  }

  const border = isMd3
    ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
    : 'border-neon-cyan/20'
  const rowBorder = isMd3
    ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
    : 'border-neon-cyan/15'
  const labelCls = isMd3
    ? 'text-[var(--on-surface)] text-xs'
    : 'terminal-label'
  const mutedCls = 'font-mono text-[9px] text-text-muted'
  const btnBase = isMd3
    ? 'inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] transition-colors'
    : 'inline-flex items-center gap-1 rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-widest transition-colors'

  return (
    <div className="space-y-4">
      <div className={`border p-3 ${border} ${isMd3 ? 'rounded-2xl' : ''}`}>
        <p className={`mb-3 ${labelCls}`}>{t('settings.stickersTitle')}</p>

        {loading ? (
          <p className={mutedCls}>…</p>
        ) : loadError ? (
          <div className="space-y-2">
            <p className={mutedCls}>{t('settings.loadFailed')}</p>
            <button
              type="button"
              onClick={() => void load()}
              className={`${btnBase} ${
                isMd3
                  ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)]'
                  : 'border-neon-cyan/30 text-neon-cyan/70 hover:border-neon-cyan/60 hover:text-neon-cyan'
              }`}
            >
              {t('msg.retry')}
            </button>
          </div>
        ) : packs.length === 0 ? (
          <p className={mutedCls}>{t('settings.stickersEmpty')}</p>
        ) : (
          <div className="space-y-2">
            {packs.map((pack) => (
              <div
                key={pack.id}
                className={`flex items-center gap-3 border-b pb-2 last:border-b-0 last:pb-0 ${rowBorder}`}
              >
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${isMd3 ? 'text-[var(--on-surface)] text-sm' : 'font-mono text-[11px] text-neon-cyan'}`}>
                    {pack.title}
                  </p>
                  <p className={mutedCls}>
                    {pack.format.toUpperCase()}
                    {pack.tgSource ? ` · @${pack.tgSource}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {pack.tgSource ? (
                    <button
                      type="button"
                      disabled={!!refreshingId}
                      onClick={() => void handleRefresh(pack)}
                      title={t('settings.stickersRefresh')}
                      className={`${btnBase} ${
                        isMd3
                          ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-40'
                          : 'border-neon-cyan/30 text-neon-cyan/70 hover:border-neon-cyan/60 hover:text-neon-cyan disabled:opacity-40'
                      }`}
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshingId === pack.id ? 'animate-spin' : ''}`} />
                      <span className="hidden sm:inline">
                        {refreshingId === pack.id ? t('settings.stickersRefreshing') : t('settings.stickersRefresh')}
                      </span>
                    </button>
                  ) : null}

                  <button
                    type="button"
                    disabled={!!deletingId}
                    onClick={() => void handleDelete(pack)}
                    title={t('settings.stickersDelete')}
                    className={`${btnBase} ${
                      isMd3
                        ? 'bg-[color-mix(in_srgb,var(--danger,#f44336)_10%,transparent)] text-[var(--danger,#f44336)] hover:bg-[color-mix(in_srgb,var(--danger,#f44336)_18%,transparent)] disabled:opacity-40'
                        : 'border-neon-red/30 text-neon-red/70 hover:border-neon-red/60 hover:text-neon-red disabled:opacity-40'
                    }`}
                  >
                    <Trash2 className="h-3 w-3" />
                    <span className="hidden sm:inline">{t('settings.stickersDelete')}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

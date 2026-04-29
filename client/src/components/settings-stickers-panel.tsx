'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2, Globe, Lock, Link2 } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import {
  cloneStickerPack,
  fetchStickerPacks,
  deleteStickerPack,
  refreshStickerPack,
  setPackVisibility,
  importTelegramStickerPack,
  type StickerPack,
} from '@/lib/api/stickers'
import { explainStickerError, formatStickerAccessScope } from '@/lib/sticker-errors'
import { toastError, toastSuccess } from '@/store/toastStore'

function buildShareLink(packId: string): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  const base = appUrl || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/stickers/add/${packId}`
}

export function SettingsStickersPanel() {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [cloningId, setCloningId] = useState<string | null>(null)
  const [visibilityId, setVisibilityId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [importInput, setImportInput] = useState('')
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setPacks(await fetchStickerPacks())
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'LOAD_FAILED'
      setLoadError(msg)
      toastError(explainStickerError(msg, t), { title: t('settings.stickersTitle') })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleDelete = async (pack: StickerPack) => {
    if (pack.accessScope !== 'owned') {
      toastError(t('settings.stickersOwnerOnly'), { title: t('settings.stickersTitle') })
      return
    }
    if (deletingId) return
    setDeletingId(pack.id)
    try {
      await deleteStickerPack(pack.id)
      setPacks((prev) => prev.filter((p) => p.id !== pack.id))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'REQUEST_FAILED'
      toastError(explainStickerError(msg, t), { title: t('settings.stickersTitle') })
    } finally {
      setDeletingId(null)
    }
  }

  const handleRefresh = async (pack: StickerPack) => {
    if (pack.accessScope !== 'owned') {
      toastError(t('settings.stickersOwnerOnly'), { title: t('settings.stickersTitle') })
      return
    }
    if (refreshingId) return
    setRefreshingId(pack.id)
    try {
      await refreshStickerPack(pack.id)
      toastSuccess(t('settings.stickersRefreshDone'), { title: pack.title })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'REQUEST_FAILED'
      toastError(explainStickerError(msg, t), { title: t('settings.stickersTitle') })
    } finally {
      setRefreshingId(null)
    }
  }

  const handleClone = async (pack: StickerPack) => {
    if (cloningId) return
    setCloningId(pack.id)
    try {
      const out = await cloneStickerPack(pack.id)
      toastSuccess(out.already_owned ? t('stickers.alreadyMine') : t('stickers.addedMine'), { title: pack.title })
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'CLONE_PACK_FAILED'
      toastError(explainStickerError(msg, t), { title: t('settings.stickersTitle') })
    } finally {
      setCloningId(null)
    }
  }

  const handleToggleVisibility = async (pack: StickerPack) => {
    if (visibilityId) return
    setVisibilityId(pack.id)
    const makePublic = !pack.isPublic
    try {
      await setPackVisibility(pack.id, makePublic)
      setPacks((prev) =>
        prev.map((p) => (p.id === pack.id ? { ...p, isPublic: makePublic } : p))
      )
      toastSuccess(
        makePublic ? t('settings.stickersPublished') : t('settings.stickersUnpublished'),
        { title: pack.title }
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'REQUEST_FAILED'
      toastError(explainStickerError(msg, t), { title: t('settings.stickersTitle') })
    } finally {
      setVisibilityId(null)
    }
  }

  const handleCopyLink = async (pack: StickerPack) => {
    const url = buildShareLink(pack.id)
    try {
      await navigator.clipboard.writeText(url)
      toastSuccess(t('settings.stickersCopied'), { title: pack.title })
    } catch {
      toastError(url, { title: pack.title })
    }
  }

  const handleImport = async () => {
    const raw = importInput.trim()
    if (!raw || importing) return
    setImporting(true)
    try {
      const out = await importTelegramStickerPack(raw)
      toastSuccess(
        out.imported ? t('settings.stickersImportDone') : t('settings.stickersImportAlready'),
        { title: t('settings.stickersImportTitle') }
      )
      setImportInput('')
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'IMPORT_FAILED'
      if (msg.includes('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')) {
        toastError(t('settings.stickersImportNoBotToken'), { title: t('settings.stickersImportTitle') })
      } else {
        toastError(explainStickerError(msg, t), { title: t('settings.stickersImportTitle') })
      }
    } finally {
      setImporting(false)
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
      {/* Import from Telegram */}
      <div className={`border p-3 ${border} ${isMd3 ? 'rounded-2xl' : ''}`}>
        <p className={`mb-2 ${labelCls}`}>{t('settings.stickersImportTitle')}</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={importInput}
            onChange={(e) => setImportInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleImport() }}
            placeholder={t('settings.stickersImportPlaceholder')}
            className={`min-w-0 flex-1 px-3 py-1.5 text-[11px] focus:outline-none ${
              isMd3
                ? 'rounded-full border border-[color-mix(in_srgb,var(--on-surface)_20%,transparent)] bg-[var(--surface-variant)] text-[var(--on-surface)]'
                : 'border border-neon-cyan/25 bg-void font-mono text-neon-cyan placeholder:text-text-muted/60'
            }`}
          />
          <button
            type="button"
            disabled={!importInput.trim() || importing}
            onClick={() => void handleImport()}
            className={`shrink-0 ${btnBase} ${
              isMd3
                ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-40'
                : 'border-neon-cyan/30 text-neon-cyan/70 hover:border-neon-cyan/60 hover:text-neon-cyan disabled:opacity-40'
            }`}
          >
            {importing ? t('settings.stickersImporting') : t('settings.stickersImportBtn')}
          </button>
        </div>
      </div>

      {/* Pack list */}
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
                    {pack.accessScope === 'owned' && pack.isPublic ? ' · 🌐' : ''}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {pack.accessScope === 'owned' ? (
                    <>
                      {/* Toggle public/private */}
                      <button
                        type="button"
                        disabled={!!visibilityId}
                        onClick={() => void handleToggleVisibility(pack)}
                        title={pack.isPublic ? t('settings.stickersMakePrivate') : t('settings.stickersMakePublic')}
                        className={`${btnBase} ${
                          pack.isPublic
                            ? isMd3
                              ? 'bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] disabled:opacity-40'
                              : 'border-neon-cyan/50 text-neon-cyan hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40'
                            : isMd3
                              ? 'bg-transparent text-[var(--on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] disabled:opacity-40'
                              : 'border-neon-cyan/20 text-neon-cyan/40 hover:border-neon-cyan/40 hover:text-neon-cyan/70 disabled:opacity-40'
                        }`}
                      >
                        {pack.isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                      </button>

                      {/* Copy share link (only when public) */}
                      {pack.isPublic && (
                        <button
                          type="button"
                          onClick={() => void handleCopyLink(pack)}
                          title={t('settings.stickersCopyLink')}
                          className={`${btnBase} ${
                            isMd3
                              ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)]'
                              : 'border-neon-cyan/30 text-neon-cyan/70 hover:border-neon-cyan/60 hover:text-neon-cyan'
                          }`}
                        >
                          <Link2 className="h-3 w-3" />
                        </button>
                      )}

                      {/* Refresh from Telegram */}
                      {pack.tgSource && (
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
                        </button>
                      )}

                      {/* Delete */}
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
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={!!cloningId}
                        onClick={() => void handleClone(pack)}
                        className={`${btnBase} ${
                          isMd3
                            ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-40'
                            : 'border-neon-cyan/30 text-neon-cyan/70 hover:border-neon-cyan/60 hover:text-neon-cyan disabled:opacity-40'
                        }`}
                      >
                        <span className="hidden sm:inline">
                          {cloningId === pack.id ? t('stickers.adding') : t('stickers.addToMine')}
                        </span>
                        <span className="sm:hidden">+</span>
                      </button>
                      <span className={mutedCls}>
                        {formatStickerAccessScope(pack.accessScope, t)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

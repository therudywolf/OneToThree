'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { useShell } from '@/components/ui/shell'
import { useThemeStore } from '@/store/themeStore'
import { ChatEmojiPicker } from '@/components/chat/chat-emoji-picker'
import {
  cloneStickerPack,
  fetchPackStickers,
  fetchStickerPacks,
  loadStickerDisplayUrl,
  reloadStickerDisplayUrl,
  importTelegramStickerPack,
  type Sticker,
  type StickerPack,
} from '@/lib/api/stickers'
import {
  addGifFavorite,
  fetchGifFavorites,
  fetchTrendingGifs,
  removeGifFavorite,
  searchGifs,
  type GifHit,
} from '@/lib/api/gif'
import { buildStickerPlaintext } from '@/lib/sticker-payload'
import { toastError, toastSuccess } from '@/store/toastStore'

type Tab = 'emoji' | 'sticker' | 'gif'
const STICKER_FAVORITES_KEY = 'p13:favorite-stickers:v1'

export type ComposerPickerPanelProps = {
  layout: 'dock' | 'modal'
  onEmoji: (emoji: string) => void
  onStickerSend: (json: string) => Promise<void>
  onGifPick?: (gif: GifHit) => Promise<void> | void
  /** Called after a sticker is sent (e.g. close modal). */
  onAfterStickerSend?: () => void
}

export function ComposerPickerPanel({
  layout,
  onEmoji,
  onStickerSend,
  onGifPick,
  onAfterStickerSend,
}: ComposerPickerPanelProps) {
  const { t } = useTranslation()
  const { isTerminal } = useShell()
  const themeId = useThemeStore((s) => s.theme)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const [tab, setTab] = useState<Tab>('emoji')
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [packsErr, setPacksErr] = useState<string | null>(null)
  const [packsLoading, setPacksLoading] = useState(false)
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [stickers, setStickers] = useState<Sticker[]>([])
  const [stickersLoading, setStickersLoading] = useState(false)
  const [stickerSrcById, setStickerSrcById] = useState<Record<string, string>>({})
  const [stickerRetryById, setStickerRetryById] = useState<Record<string, boolean>>({})
  const [packPreviewById, setPackPreviewById] = useState<Record<string, string>>({})
  const [favoriteStickers, setFavoriteStickers] = useState<Array<{
    sticker: Sticker
    packId: string
    format: StickerPack['format']
    src: string
  }>>([])
  const [importName, setImportName] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [cloneBusyPackId, setCloneBusyPackId] = useState<string | null>(null)
  const [gifQuery, setGifQuery] = useState('')
  const [gifBusy, setGifBusy] = useState(false)
  const [gifErr, setGifErr] = useState<string | null>(null)
  const [gifs, setGifs] = useState<GifHit[]>([])
  const [gifDegraded, setGifDegraded] = useState(false)
  const [gifFavorites, setGifFavorites] = useState<GifHit[]>([])
  const [gifFavBusyId, setGifFavBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(STICKER_FAVORITES_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Array<{
        sticker: Sticker
        packId: string
        format: StickerPack['format']
        src: string
      }>
      if (Array.isArray(parsed)) setFavoriteStickers(parsed.slice(0, 60))
    } catch {
      // non-fatal
    }
  }, [])

  const persistFavoriteStickers = useCallback((items: Array<{
    sticker: Sticker
    packId: string
    format: StickerPack['format']
    src: string
  }>) => {
    setFavoriteStickers(items)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STICKER_FAVORITES_KEY, JSON.stringify(items.slice(0, 60)))
    } catch {
      // non-fatal
    }
  }, [])

  const pickerHeight = layout === 'dock' ? 420 : 360

  const loadPacks = useCallback(async () => {
    setPacksLoading(true)
    setPacksErr(null)
    try {
      const list = await fetchStickerPacks()
      setPacks(list)
    } catch {
      setPacksErr(t('settings.loadFailed'))
      setPacks([])
    } finally {
      setPacksLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab !== 'sticker') return
    void loadPacks()
  }, [tab, loadPacks])

  useEffect(() => {
    if (tab !== 'sticker' || packs.length === 0) return
    let cancelled = false
    void (async () => {
      const next: Record<string, string> = {}
      for (const p of packs) {
        try {
          const rows = await fetchPackStickers(p.id)
          const first = rows[0]
          if (!first) continue
          next[p.id] = await loadStickerDisplayUrl(first.mediaKey)
        } catch {
          // non-fatal preview miss
        }
      }
      if (!cancelled) setPackPreviewById(next)
    })()
    return () => {
      cancelled = true
    }
  }, [tab, packs])

  useEffect(() => {
    if (tab !== 'sticker' || !selectedPackId) {
      setStickers([])
      return
    }
    let cancelled = false
    setStickersLoading(true)
    void fetchPackStickers(selectedPackId)
      .then(async (rows) => {
        if (cancelled) return
        setStickers(rows)
        setStickerRetryById({})
        const next: Record<string, string> = {}
        await Promise.all(
          rows.map(async (s) => {
            try {
              next[s.id] = await loadStickerDisplayUrl(s.mediaKey)
            } catch {
              next[s.id] = s.url
            }
          })
        )
        if (!cancelled) setStickerSrcById(next)
      })
      .catch(() => {
        if (!cancelled) setStickers([])
      })
      .finally(() => {
        if (!cancelled) setStickersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, selectedPackId])

  useEffect(() => {
    if (tab !== 'gif') return
    const q = gifQuery.trim()
    const isTrendingMode = q.length < 2
    let cancelled = false
    setGifBusy(true)
    setGifErr(null)
    setGifDegraded(false)
    const timer = setTimeout(() => {
      const run = isTrendingMode ? fetchTrendingGifs(48) : searchGifs(q, 48)
      void run
        .then((result) => {
          if (cancelled) return
          setGifs(result.items)
          setGifDegraded(result.degraded)
        })
        .catch((e) => {
          if (!cancelled) {
            setGifs([])
            setGifErr(
              e instanceof Error && e.message.startsWith('GIF_FETCH_')
                ? t('gif.fetchFailed')
                : t('composer.gifSearchFailed')
            )
          }
        })
        .finally(() => {
          if (!cancelled) setGifBusy(false)
        })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tab, gifQuery])

  useEffect(() => {
    if (tab !== 'gif') return
    let cancelled = false
    void fetchGifFavorites()
      .then((rows) => {
        if (!cancelled) {
          setGifFavorites(rows.map((r) => ({
            id: r.id,
            title: r.title,
            previewUrl: r.previewUrl,
            originalUrl: r.originalUrl,
          })))
        }
      })
      .catch(() => {
        if (!cancelled) setGifFavorites([])
      })
    return () => {
      cancelled = true
    }
  }, [tab])

  const onImport = async () => {
    const name = importName.trim()
    if (!name || importBusy) return
    setImportBusy(true)
    try {
      await importTelegramStickerPack(name)
      setImportName('')
      await loadPacks()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'IMPORT_FAILED', { title: 'Stickers' })
    } finally {
      setImportBusy(false)
    }
  }

  const onClonePack = async (packId: string) => {
    if (cloneBusyPackId) return
    setCloneBusyPackId(packId)
    try {
      const out = await cloneStickerPack(packId)
      toastSuccess(out.already_owned ? t('stickers.alreadyMine') : t('stickers.addedMine'), { title: 'Stickers' })
      await loadPacks()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'CLONE_FAILED', { title: 'Stickers' })
    } finally {
      setCloneBusyPackId(null)
    }
  }

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`inline-flex h-9 items-center justify-center rounded px-3 font-mono text-[10px] uppercase tracking-widest transition-colors ${
        tab === id
          ? isRetro
            ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] normal-case text-[#123659] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
            : isTerminal
            ? 'bg-neon-cyan/15 text-neon-cyan'
            : 'bg-[var(--md3-primary-container,#2a3441)] text-[var(--on-surface)]'
          : isRetro
            ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] normal-case text-[#3f4752] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
            : 'text-text-muted hover:text-neon-cyan/80'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-neon-cyan/15 px-2 py-1.5">
        {tabBtn('emoji', t('composer.tabEmoji'))}
        {tabBtn('sticker', t('composer.tabSticker'))}
        {tabBtn('gif', t('composer.tabGif'))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'emoji' ? (
          <div className="flex h-full min-h-0 flex-col gap-2 p-2">
            <div
              className={`min-h-0 overflow-hidden rounded border ${
                isRetro
                  ? 'border-[#6f747c] bg-[#d4d0c8]'
                  : isTerminal
                    ? 'border-neon-cyan/15 bg-void/60'
                    : 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[color-mix(in_srgb,var(--on-surface)_4%,transparent)]'
              }`}
              style={{ maxHeight: pickerHeight }}
            >
              <ChatEmojiPicker
                height={pickerHeight}
                onPick={onEmoji}
              />
            </div>
          </div>
        ) : null}

        {tab === 'sticker' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            <div className="flex flex-wrap gap-1">
              <input
                type="text"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder={t('composer.stickerImportPlaceholder')}
                className="p13-picker-input min-w-[8rem] flex-1 rounded"
              />
              <button
                type="button"
                disabled={importBusy || !importName.trim()}
                onClick={() => void onImport()}
                className={`inline-flex h-10 shrink-0 items-center justify-center rounded px-3 text-[10px] disabled:opacity-40 ${
                  isRetro
                    ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] normal-case tracking-[0.02em] text-[#123659] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
                    : 'border border-neon-cyan/40 font-mono uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'
                }`}
              >
                {importBusy ? '…' : t('composer.stickerImport')}
              </button>
            </div>
            <p className="font-mono text-[9px] leading-snug text-text-muted/80">
              {t('composer.stickerImportHint')}
            </p>

            {packsLoading ? (
              <div className="py-6 text-center font-mono text-[10px] text-text-muted">…</div>
            ) : packsErr ? (
              <div className="py-2 font-mono text-[10px] text-danger/90">{packsErr}</div>
            ) : packs.length === 0 ? (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">
                {t('composer.stickerEmpty')}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1 border-b border-neon-cyan/10 pb-2">
                {packs.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPackId(p.id)}
                    className={`inline-flex h-8 max-w-[12rem] items-center gap-1.5 truncate rounded px-2 text-[10px] ${
                      selectedPackId === p.id
                        ? isRetro
                          ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] normal-case tracking-[0.02em] text-[#123659] shadow-[inset_1px_1px_0_#7d7d7d,inset_-1px_-1px_0_#ffffff]'
                          : 'bg-neon-cyan/20 text-neon-cyan'
                        : isRetro
                          ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] normal-case tracking-[0.02em] text-[#3f4752] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
                          : 'bg-void/50 text-text-muted hover:text-neon-cyan/90'
                    }`}
                    title={p.title}
                  >
                    {packPreviewById[p.id] ? (
                      <img
                        src={packPreviewById[p.id]}
                        alt=""
                        className="h-5 w-5 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <span className="truncate">{p.title}</span>
                    {p.accessScope === 'shared' ? (
                      <span className="ml-1 shrink-0 text-[8px] uppercase tracking-widest text-accent-2/80">
                        SH
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}

            {selectedPackId ? (
              stickersLoading ? (
                <div className="py-4 text-center font-mono text-[10px] text-text-muted">…</div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
                  {favoriteStickers.length > 0 ? (
                    <div className="mb-2">
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-text-muted">
                        {t('stickers.favorites')}
                      </p>
                      <div className="grid grid-cols-6 gap-1">
                        {favoriteStickers.slice(0, 18).map((fav) => (
                          <button
                            key={`fav-st-${fav.sticker.id}`}
                            type="button"
                            title={fav.sticker.emoji || 'sticker'}
                            onClick={() => {
                              const json = buildStickerPlaintext(fav.sticker, fav.packId, fav.format)
                              void onStickerSend(json)
                            }}
                            className="p13-sticker-tile flex aspect-square items-center justify-center rounded"
                          >
                            <img src={fav.src} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(() => {
                    const selectedPack = packs.find((p) => p.id === selectedPackId)
                    if (!selectedPack || selectedPack.accessScope === 'owned') return null
                    return (
                      <div className="mb-2 flex items-center justify-between rounded border border-neon-cyan/20 bg-void/40 px-2 py-1">
                        <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                          {selectedPack.accessScope === 'public' ? 'Public pack' : 'Shared pack'}
                        </span>
                        <button
                          type="button"
                          disabled={cloneBusyPackId === selectedPack.id}
                          onClick={() => void onClonePack(selectedPack.id)}
                          className="rounded border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
                        >
                          {cloneBusyPackId === selectedPack.id ? t('stickers.adding') : t('stickers.addToMine')}
                        </button>
                      </div>
                    )
                  })()}
                  <div className="grid grid-cols-5 gap-1 sm:grid-cols-6">
                  {stickers.map((s) => {
                    const stickerSrc = stickerSrcById[s.id] ?? s.url
                    const isWebm = /\.webm($|\?)/i.test(stickerSrc) || /\.webm$/i.test(s.mediaKey)
                    return (
                    <button
                      key={s.id}
                      type="button"
                      title={s.emoji || 'sticker'}
                      onClick={() => {
                        const packMeta = packs.find((p) => p.id === selectedPackId)
                        if (!packMeta) return
                        const json = buildStickerPlaintext(s, selectedPackId, packMeta.format)
                        void (async () => {
                          try {
                            await onStickerSend(json)
                            onAfterStickerSend?.()
                          } catch (e) {
                            toastError(e instanceof Error ? e.message : 'SEND_FAILED', { title: 'Stickers' })
                          }
                        })()
                      }}
                      className="p13-sticker-tile relative flex aspect-square items-center justify-center rounded"
                    >
                      <span
                        className="absolute right-1 top-1 rounded border border-[color-mix(in_srgb,var(--void)_45%,transparent)] bg-[color-mix(in_srgb,var(--void)_70%,transparent)] px-1 text-[9px] text-[var(--on-surface)] backdrop-blur-sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          const packMeta = packs.find((p) => p.id === selectedPackId)
                          if (!packMeta) return
                          const exists = favoriteStickers.some((f) => f.sticker.id === s.id)
                          if (exists) {
                            persistFavoriteStickers(
                              favoriteStickers.filter((f) => f.sticker.id !== s.id)
                            )
                          } else {
                            persistFavoriteStickers([
                              { sticker: s, packId: selectedPackId, format: packMeta.format, src: stickerSrc },
                              ...favoriteStickers,
                            ])
                          }
                        }}
                      >
                        {favoriteStickers.some((f) => f.sticker.id === s.id) ? '★' : '☆'}
                      </span>
                      {isWebm ? (
                        <video
                          src={stickerSrc}
                          className="max-h-full max-w-full object-contain"
                          muted
                          autoPlay
                          loop
                          playsInline
                          preload="metadata"
                          onError={() => {
                            if (stickerRetryById[s.id]) return
                            setStickerRetryById((prev) => ({ ...prev, [s.id]: true }))
                            void reloadStickerDisplayUrl(s.mediaKey)
                              .then((url) => {
                                setStickerSrcById((prev) => ({ ...prev, [s.id]: url }))
                              })
                              .catch(() => {
                                // non-fatal; keep placeholder if both URLs fail
                              })
                          }}
                        />
                      ) : (
                        <img
                          src={stickerSrc}
                          alt=""
                          className="max-h-full max-w-full object-contain"
                          loading="lazy"
                          onError={() => {
                            if (stickerRetryById[s.id]) return
                            setStickerRetryById((prev) => ({ ...prev, [s.id]: true }))
                            void reloadStickerDisplayUrl(s.mediaKey)
                              .then((url) => {
                                setStickerSrcById((prev) => ({ ...prev, [s.id]: url }))
                              })
                              .catch(() => {
                                // non-fatal; keep placeholder if both URLs fail
                              })
                          }}
                        />
                      )}
                    </button>
                    )
                  })}
                </div>
                </div>
              )
            ) : null}
          </div>
        ) : null}

        {tab === 'gif' ? (
          <div className="flex min-h-0 flex-col gap-2 p-2">
            {gifFavorites.length > 0 ? (
              <div className="space-y-1">
                <p className="font-mono text-[9px] uppercase tracking-widest text-text-muted">{t('gif.favorites')}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {gifFavorites.map((g) => (
                    <div key={`fav-${g.id}`} className="relative">
                      <button
                        type="button"
                        className="p13-media-tile rounded"
                        onClick={() => {
                          void (async () => {
                            try {
                              if (onGifPick) await onGifPick(g)
                              else onEmoji(` ${g.originalUrl} `)
                              onAfterStickerSend?.()
                            } catch (e) {
                              toastError(e instanceof Error ? e.message : 'SEND_FAILED', { title: 'GIF' })
                            }
                          })()
                        }}
                        title={g.title}
                      >
                        <img src={g.previewUrl} alt={g.title} className="h-20 w-full object-cover" loading="lazy" />
                      </button>
                      <button
                        type="button"
                        disabled={gifFavBusyId === g.id}
                        onClick={() => {
                          setGifFavBusyId(g.id)
                          void removeGifFavorite(g.id)
                            .then(() => {
                              setGifFavorites((prev) => prev.filter((x) => x.id !== g.id))
                            })
                            .catch((e) => {
                              toastError(e instanceof Error ? e.message : 'GIF_FAVORITE_REMOVE_FAILED', { title: 'GIF' })
                            })
                            .finally(() => {
                              setGifFavBusyId(null)
                            })
                        }}
                        className="absolute right-1 top-1 rounded border border-[color-mix(in_srgb,var(--void)_45%,transparent)] bg-[color-mix(in_srgb,var(--void)_70%,transparent)] px-1 text-[9px] text-[var(--on-surface)] backdrop-blur-sm disabled:opacity-50"
                        aria-label="Remove favorite gif"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <input
              type="text"
              value={gifQuery}
              onChange={(e) => setGifQuery(e.target.value)}
              placeholder={t('composer.gifSearchPlaceholder')}
              className="p13-picker-input rounded"
            />
            {gifBusy ? (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">…</div>
            ) : gifErr ? (
              <div className="py-2 font-mono text-[10px] text-danger/90">{gifErr}</div>
            ) : gifs.length > 0 ? (
              <>
                {gifDegraded ? (
                  <div className="py-2 font-mono text-[10px] text-text-muted">
                    {t('composer.gifFallbackMode')}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {gifs.map((g) => (
                    <div key={g.id} className="relative">
                      <button
                        type="button"
                        className="p13-media-tile rounded"
                        onClick={() => {
                          void (async () => {
                            try {
                              if (onGifPick) await onGifPick(g)
                              else onEmoji(` ${g.originalUrl} `)
                              onAfterStickerSend?.()
                            } catch (e) {
                              toastError(e instanceof Error ? e.message : 'SEND_FAILED', { title: 'GIF' })
                            }
                          })()
                        }}
                        title={g.title}
                      >
                        <img src={g.previewUrl} alt={g.title} className="h-24 w-full object-cover" loading="lazy" />
                      </button>
                      <button
                        type="button"
                        disabled={gifFavBusyId === g.id}
                        onClick={() => {
                          setGifFavBusyId(g.id)
                          void addGifFavorite(g)
                            .then(() => {
                              setGifFavorites((prev) => {
                                if (prev.some((x) => x.id === g.id)) return prev
                                return [g, ...prev].slice(0, 60)
                              })
                            })
                            .catch((e) => {
                              toastError(e instanceof Error ? e.message : 'GIF_FAVORITE_ADD_FAILED', { title: 'GIF' })
                            })
                            .finally(() => setGifFavBusyId(null))
                        }}
                        className="absolute right-1 top-1 rounded border border-[color-mix(in_srgb,var(--void)_45%,transparent)] bg-[color-mix(in_srgb,var(--void)_70%,transparent)] px-1 text-[9px] text-[var(--on-surface)] backdrop-blur-sm disabled:opacity-50"
                        aria-label="Add favorite gif"
                      >
                        {gifFavorites.some((x) => x.id === g.id) ? '★' : '+'}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : gifDegraded ? (
              <div className="py-2 font-mono text-[10px] text-text-muted">
                {t('composer.gifFallbackMode')}
              </div>
            ) : gifQuery.trim().length < 2 ? (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">{t('composer.gifPopular')}</div>
            ) : (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">{t('composer.gifEmpty')}</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

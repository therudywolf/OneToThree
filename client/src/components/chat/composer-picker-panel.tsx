'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Theme } from 'emoji-picker-react'
import { useTranslation } from '@/hooks/use-translation'
import { useShell } from '@/components/ui/shell'
import {
  fetchPackStickers,
  fetchStickerAssetUrl,
  fetchStickerPacks,
  importTelegramStickerPack,
  type Sticker,
  type StickerPack,
} from '@/lib/api/stickers'
import { fetchTrendingGifs, searchGifs, type GifHit } from '@/lib/api/gif'
import { buildStickerPlaintext } from '@/lib/sticker-payload'
import { toastError } from '@/store/toastStore'

const LazyEmojiPicker = dynamic(
  () => import('emoji-picker-react').then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[280px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
        loading…
      </div>
    ),
  }
)

type Tab = 'emoji' | 'sticker' | 'gif'

export type ComposerPickerPanelProps = {
  layout: 'dock' | 'modal'
  onEmoji: (emoji: string) => void
  onStickerSend: (json: string) => Promise<void>
  onGifPick?: (gifUrl: string) => void
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
  const [tab, setTab] = useState<Tab>('emoji')
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [packsErr, setPacksErr] = useState<string | null>(null)
  const [packsLoading, setPacksLoading] = useState(false)
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [stickers, setStickers] = useState<Sticker[]>([])
  const [stickersLoading, setStickersLoading] = useState(false)
  const [stickerSrcById, setStickerSrcById] = useState<Record<string, string>>({})
  const [stickerRetryById, setStickerRetryById] = useState<Record<string, boolean>>({})
  const [importName, setImportName] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [gifQuery, setGifQuery] = useState('')
  const [gifBusy, setGifBusy] = useState(false)
  const [gifErr, setGifErr] = useState<string | null>(null)
  const [gifs, setGifs] = useState<GifHit[]>([])

  const pickerHeight = layout === 'dock' ? 360 : 320

  const loadPacks = useCallback(async () => {
    setPacksLoading(true)
    setPacksErr(null)
    try {
      const list = await fetchStickerPacks()
      setPacks(list)
    } catch (e) {
      setPacksErr(e instanceof Error ? e.message : 'LOAD_PACKS')
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
    if (tab !== 'sticker' || !selectedPackId) {
      setStickers([])
      return
    }
    let cancelled = false
    setStickersLoading(true)
    void fetchPackStickers(selectedPackId)
      .then((rows) => {
        if (!cancelled) {
          setStickers(rows)
          setStickerSrcById(
            rows.reduce<Record<string, string>>((acc, s) => {
              acc[s.id] = s.url
              return acc
            }, {})
          )
          setStickerRetryById({})
        }
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
    const timer = setTimeout(() => {
      const run = isTrendingMode ? fetchTrendingGifs(24) : searchGifs(q, 24)
      void run
        .then((rows) => {
          if (!cancelled) setGifs(rows)
        })
        .catch((e) => {
          if (!cancelled) {
            setGifs([])
            setGifErr(e instanceof Error ? e.message : 'GIF_SEARCH_FAILED')
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

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`inline-flex h-9 items-center justify-center rounded px-3 font-mono text-[10px] uppercase tracking-widest transition-colors ${
        tab === id
          ? isTerminal
            ? 'bg-neon-cyan/15 text-neon-cyan'
            : 'bg-[var(--md3-primary-container,#2a3441)] text-[var(--on-surface)]'
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
          <div className="p-2">
            <LazyEmojiPicker
              onEmojiClick={(data: { emoji: string }) => {
                onEmoji(data.emoji)
              }}
              skinTonesDisabled
              previewConfig={{ showPreview: false }}
              width={layout === 'dock' ? '100%' : 300}
              height={pickerHeight}
              theme={isTerminal ? Theme.DARK : Theme.LIGHT}
            />
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
                className="min-w-[8rem] h-10 flex-1 rounded border border-neon-cyan/25 bg-void/40 px-3 font-mono text-[11px] text-[color:var(--on-surface)] placeholder:text-text-muted"
              />
              <button
                type="button"
                disabled={importBusy || !importName.trim()}
                onClick={() => void onImport()}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded border border-neon-cyan/40 px-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
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
                    className={`inline-flex h-8 max-w-[10rem] items-center truncate rounded px-3 font-mono text-[10px] ${
                      selectedPackId === p.id
                        ? 'bg-neon-cyan/20 text-neon-cyan'
                        : 'bg-void/50 text-text-muted hover:text-neon-cyan/90'
                    }`}
                    title={p.title}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            )}

            {selectedPackId ? (
              stickersLoading ? (
                <div className="py-4 text-center font-mono text-[10px] text-text-muted">…</div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
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
                      className="flex aspect-square items-center justify-center overflow-hidden rounded border border-neon-cyan/15 bg-void/40 hover:border-neon-cyan/50"
                    >
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
                            void fetchStickerAssetUrl(s.mediaKey)
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
                            void fetchStickerAssetUrl(s.mediaKey)
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
            <input
              type="text"
              value={gifQuery}
              onChange={(e) => setGifQuery(e.target.value)}
              placeholder={t('composer.gifSearchPlaceholder')}
              className="h-10 w-full rounded border border-neon-cyan/25 bg-void/40 px-3 font-mono text-[11px] text-[color:var(--on-surface)] placeholder:text-text-muted"
            />
            {gifBusy ? (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">…</div>
            ) : gifErr ? (
              <div className="py-2 font-mono text-[10px] text-danger/90">{gifErr}</div>
            ) : gifQuery.trim().length < 2 ? (
              <div className="py-2 text-center font-mono text-[10px] text-text-muted">{t('composer.gifPopular')}</div>
            ) : gifs.length === 0 ? (
              <div className="py-4 text-center font-mono text-[10px] text-text-muted">{t('composer.gifEmpty')}</div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {gifs.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className="overflow-hidden rounded border border-neon-cyan/15 bg-void/40 hover:border-neon-cyan/50"
                    onClick={() => {
                      if (onGifPick) onGifPick(g.originalUrl)
                      else onEmoji(` ${g.originalUrl} `)
                      onAfterStickerSend?.()
                    }}
                    title={g.title}
                  >
                    <img src={g.previewUrl} alt={g.title} className="h-24 w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

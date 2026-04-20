'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  base64ToArrayBuffer,
  decryptBinary,
  importAesGcm256RawKey,
} from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'
import { getCachedMedia, setCachedMedia } from '@/lib/media-cache'
import { useTranslation } from '@/hooks/use-translation'
import type { AlbumEnvelopeV1, AlbumItemV1 } from '@/lib/attachment-envelope'

type Props = {
  messageId: string
  envelope: AlbumEnvelopeV1
  sharedKey: CryptoKey | null
  onMediaClick?: (media: {
    id: string
    url: string
    type: 'image' | 'video'
    mimeType: string
  }) => void
}

type LoadedItem = {
  item: AlbumItemV1
  url: string | null
  failed: boolean
}

function chooseGridClass(n: number): string {
  if (n <= 1) return 'grid-cols-1'
  if (n === 2) return 'grid-cols-2'
  if (n === 3) return 'grid-cols-2'
  if (n === 4) return 'grid-cols-2'
  if (n <= 6) return 'grid-cols-3'
  return 'grid-cols-3'
}

function isImageMime(m: string): boolean {
  return m.toLowerCase().startsWith('image/')
}
function isVideoMime(m: string): boolean {
  return m.toLowerCase().startsWith('video/')
}

/**
 * Renders a p13:'album' envelope as a responsive grid of up to 10 media tiles.
 * Each item is decrypted independently using its own wrapped AES-GCM key.
 */
export function AlbumBubble({ messageId, envelope, sharedKey, onMediaClick }: Props) {
  const { t } = useTranslation()
  const [items, setItems] = useState<LoadedItem[]>(
    () => envelope.items.map((it) => ({ item: it, url: null, failed: false })),
  )
  const urlsRef = useRef<string[]>([])
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const decryptOne = useCallback(
    async (item: AlbumItemV1, idx: number) => {
      if (!sharedKey) return
      try {
        const cacheKey = `${messageId}#${idx}`
        const cached = await getCachedMedia(cacheKey)
        if (cached?.blob) {
          const url = URL.createObjectURL(cached.blob)
          urlsRef.current.push(url)
          setItems((prev) => {
            if (!prev[idx]) return prev
            const next = prev.slice()
            next[idx] = { ...next[idx], url }
            return next
          })
          return
        }
        const downloadUrl = await getDownloadUrl(item.path)
        const res = await fetch(downloadUrl)
        if (!res.ok) {
          setItems((prev) => {
            if (!prev[idx]) return prev
            const next = prev.slice()
            next[idx] = { ...next[idx], failed: true }
            return next
          })
          return
        }
        const cipher = await res.arrayBuffer()
        const wrapPlain = await decryptBinary(
          sharedKey,
          base64ToArrayBuffer(item.wrapCt),
          item.wrapIv,
        )
        const fileKey = await importAesGcm256RawKey(wrapPlain, ['decrypt'])
        const fileIv = new Uint8Array(base64ToArrayBuffer(item.iv))
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fileIv as BufferSource },
          fileKey,
          cipher as BufferSource,
        )
        const mime = item.mimeType.split(';')[0]
        const blob = new Blob([plain], { type: mime })
        await setCachedMedia(cacheKey, blob, mime)
        const url = URL.createObjectURL(blob)
        urlsRef.current.push(url)
        setItems((prev) => {
          if (!prev[idx]) return prev
          const next = prev.slice()
          next[idx] = { ...next[idx], url }
          return next
        })
      } catch {
        setItems((prev) => {
          if (!prev[idx]) return prev
          const next = prev.slice()
          next[idx] = { ...next[idx], failed: true }
          return next
        })
      }
    },
    [messageId, sharedKey],
  )

  useEffect(() => {
    if (!visible || !sharedKey) return
    envelope.items.forEach((it, idx) => void decryptOne(it, idx))
    return () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      urlsRef.current = []
    }
  }, [visible, sharedKey, envelope.items, decryptOne])

  const gridClass = useMemo(() => chooseGridClass(envelope.items.length), [envelope.items.length])

  if (!sharedKey) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-text-muted">
        {t('errors.signalLost')}
      </div>
    )
  }

  return (
    <div>
      <div
        ref={sentinelRef}
        className={`mt-2 grid max-w-sm gap-1 ${gridClass} border border-neon-cyan/40 p-1`}
      >
        {items.map((loaded, idx) => {
          const { item, url, failed } = loaded
          const cellCls =
            'relative aspect-square w-full overflow-hidden bg-void/40 border border-neon-cyan/20'

          if (failed) {
            return (
              <div key={idx} className={cellCls}>
                <div className="flex h-full w-full items-center justify-center font-mono text-[9px] text-neon-red/70">
                  FAIL
                </div>
              </div>
            )
          }
          if (!url) {
            return (
              <div key={idx} className={cellCls}>
                <div className="flex h-full w-full items-center justify-center font-mono text-[9px] text-neon-cyan/60 animate-pulse">
                  [ DEC ]
                </div>
              </div>
            )
          }
          if (isImageMime(item.mimeType)) {
            return (
              <button
                type="button"
                key={idx}
                className={cellCls + ' cursor-pointer'}
                onClick={() =>
                  onMediaClick?.({
                    id: `${messageId}#${idx}`,
                    url,
                    type: 'image',
                    mimeType: item.mimeType.split(';')[0],
                  })
                }
                aria-label={item.fileName}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={item.fileName}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            )
          }
          if (isVideoMime(item.mimeType)) {
            return (
              <button
                type="button"
                key={idx}
                className={cellCls + ' cursor-pointer'}
                onClick={() =>
                  onMediaClick?.({
                    id: `${messageId}#${idx}`,
                    url,
                    type: 'video',
                    mimeType: item.mimeType.split(';')[0],
                  })
                }
                aria-label={item.fileName}
              >
                <video
                  src={url}
                  className="h-full w-full object-cover"
                  playsInline
                  muted
                  preload="metadata"
                />
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-void/70 px-1 py-0.5 font-mono text-[8px] text-neon-cyan">
                  ▶
                </span>
              </button>
            )
          }
          return (
            <a
              key={idx}
              href={url}
              download={item.fileName}
              className={cellCls + ' flex items-center justify-center font-mono text-[9px] text-neon-cyan'}
            >
              {item.fileName.slice(0, 12)}
            </a>
          )
        })}
      </div>
      {envelope.caption ? (
        <p className="mt-1.5 max-w-sm break-words font-mono text-[12px] leading-snug text-neon-cyan/80">
          {envelope.caption}
        </p>
      ) : null}
    </div>
  )
}

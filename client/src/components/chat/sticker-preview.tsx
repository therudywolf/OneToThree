'use client'

import { useEffect, useRef, useState } from 'react'
import type { StickerFormat } from '@/lib/api/stickers'

type Props = {
  url: string | null
  format: StickerFormat
  /** Best-effort extension hint when format may be wrong (e.g. picker pack-level vs per-sticker). */
  mediaKey?: string
  alt?: string
  className?: string
  fallbackEmoji?: string
  onLoadError?: () => void
}

function detectFormat(format: StickerFormat, mediaKey?: string, url?: string | null): StickerFormat {
  const haystack = `${mediaKey ?? ''} ${url ?? ''}`.toLowerCase()
  if (/\.tgs($|\?)/.test(haystack)) return 'tgs'
  if (/\.json($|\?)/.test(haystack)) return 'lottie'
  if (/\.webm($|\?)/.test(haystack)) return 'webm'
  if (/\.(webp|png|jpg|jpeg|gif)($|\?)/.test(haystack)) return 'static'
  return format
}

export function StickerPreview({
  url,
  format,
  mediaKey,
  alt,
  className,
  fallbackEmoji,
  onLoadError,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [lottieReady, setLottieReady] = useState(false)
  const resolvedFormat = detectFormat(format, mediaKey, url)
  const isLottie = resolvedFormat === 'tgs' || resolvedFormat === 'lottie'
  const emoji = fallbackEmoji?.trim() || '🎭'

  useEffect(() => {
    if (!url || !isLottie) return
    let cancelled = false
    let animation: { destroy: () => void } | null = null
    setLottieReady(false)

    void (async () => {
      try {
        const [{ default: lottie }, pako] = await Promise.all([
          import('lottie-web'),
          import('pako'),
        ])
        const host = hostRef.current
        if (!host || cancelled) return

        let animationData: unknown
        if (resolvedFormat === 'lottie') {
          animationData = await fetch(url).then((r) => r.json())
        } else {
          const ab = await fetch(url).then((r) => r.arrayBuffer())
          const jsonText = pako.ungzip(new Uint8Array(ab), { to: 'string' }) as string
          animationData = JSON.parse(jsonText)
        }
        if (cancelled || !hostRef.current) return
        animation = lottie.loadAnimation({
          container: hostRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: animationData as object,
        }) as { destroy: () => void }
        setLottieReady(true)
      } catch {
        if (!cancelled) onLoadError?.()
      }
    })()

    return () => {
      cancelled = true
      try {
        animation?.destroy()
      } catch {
        // ignore
      }
    }
  }, [url, isLottie, resolvedFormat, onLoadError])

  if (!url) {
    return (
      <span className={`flex items-center justify-center text-3xl opacity-60 ${className ?? ''}`}>
        {emoji}
      </span>
    )
  }

  if (resolvedFormat === 'webm') {
    return (
      <video
        src={url}
        className={className}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        onError={onLoadError}
      />
    )
  }

  if (isLottie) {
    return (
      <span className={`relative inline-flex ${className ?? ''}`}>
        <span ref={hostRef} className="block h-full w-full" />
        {!lottieReady ? (
          <span className="absolute inset-0 flex items-center justify-center text-2xl opacity-60">
            {emoji}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <img
      src={url}
      alt={alt ?? ''}
      className={className}
      loading="lazy"
      onError={onLoadError}
    />
  )
}

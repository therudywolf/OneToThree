'use client'

import { useEffect, useRef, useState } from 'react'
import type { StickerEnvelopeV1 } from '@/lib/attachment-envelope'
import { fetchStickerAssetUrl } from '@/lib/api/stickers'

type Props = { envelope: StickerEnvelopeV1 }

export function StickerBubble({ envelope }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const [lottieReady, setLottieReady] = useState(false)
  const lottieHostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setErr(false)
    const key = envelope.path
    if (!key || key.startsWith('http://') || key.startsWith('https://')) {
      setUrl(key)
      return
    }
    void fetchStickerAssetUrl(key)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setErr(true)
      })
    return () => {
      cancelled = true
    }
  }, [envelope.path])

  const emoji = envelope.fallbackEmoji?.trim() || '🎭'
  const w = envelope.width && envelope.width > 0 ? Math.min(envelope.width, 200) : undefined
  const h = envelope.height && envelope.height > 0 ? Math.min(envelope.height, 200) : undefined

  useEffect(() => {
    if (!url || (envelope.format !== 'lottie' && envelope.format !== 'tgs')) return
    let cancelled = false
    let animation: { destroy: () => void } | null = null
    setLottieReady(false)

    void (async () => {
      try {
        const [{ default: lottie }, pako] = await Promise.all([
          import('lottie-web'),
          import('pako'),
        ])
        const host = lottieHostRef.current
        if (!host || cancelled) return

        let animationData: unknown
        if (envelope.format === 'lottie') {
          animationData = await fetch(url).then((r) => r.json())
        } else {
          const ab = await fetch(url).then((r) => r.arrayBuffer())
          const jsonText = pako.ungzip(new Uint8Array(ab), { to: 'string' }) as string
          animationData = JSON.parse(jsonText)
        }
        if (cancelled || !lottieHostRef.current) return
        animation = lottie.loadAnimation({
          container: lottieHostRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: animationData as object,
        }) as { destroy: () => void }
        setLottieReady(true)
      } catch {
        if (!cancelled) setErr(true)
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
  }, [url, envelope.format])

  if (err) {
    return (
      <div className="inline-flex min-h-[120px] min-w-[120px] items-center justify-center rounded border border-neon-cyan/20 bg-void/60 p-2 text-center font-mono text-[10px] text-danger/90">
        {emoji}
        <span className="sr-only">Sticker failed to load</span>
      </div>
    )
  }

  if (!url) {
    return (
      <div className="inline-flex h-[120px] w-[120px] items-center justify-center rounded border border-neon-cyan/15 bg-void/40 text-4xl opacity-60">
        {emoji}
      </div>
    )
  }

  if (envelope.format === 'webm') {
    return (
      <video
        src={url}
        className="max-h-[200px] max-w-[200px] rounded"
        autoPlay
        loop
        muted
        playsInline
        width={w}
        height={h}
      />
    )
  }

  if (envelope.format === 'webp') {
    return (
      <img
        src={url}
        alt={emoji}
        width={w}
        height={h}
        className="max-h-[200px] max-w-[200px] rounded object-contain"
        loading="lazy"
      />
    )
  }

  // tgs / lottie
  return (
    <div className="relative inline-flex h-[160px] w-[160px] items-center justify-center overflow-hidden rounded border border-neon-cyan/20 bg-void/50 p-2">
      <div ref={lottieHostRef} className="h-full w-full" />
      {!lottieReady ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-void/30">
          <span className="text-5xl leading-none">{emoji}</span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-neon-cyan/50">
            {envelope.format === 'tgs' ? 'TGS' : 'Lottie'}
          </span>
        </div>
      ) : null}
    </div>
  )
}

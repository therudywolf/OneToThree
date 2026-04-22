'use client'

import { useEffect, useState } from 'react'
import type { StickerEnvelopeV1 } from '@/lib/attachment-envelope'
import { fetchStickerAssetUrl } from '@/lib/api/stickers'

type Props = { envelope: StickerEnvelopeV1 }

export function StickerBubble({ envelope }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)

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

  // tgs / lottie — no client decoder in deps yet
  return (
    <div className="inline-flex min-h-[120px] min-w-[120px] flex-col items-center justify-center gap-1 rounded border border-neon-cyan/20 bg-void/50 p-2">
      <span className="text-5xl leading-none">{emoji}</span>
      <span className="font-mono text-[9px] uppercase tracking-widest text-neon-cyan/50">
        {envelope.format === 'tgs' ? 'TGS' : 'Lottie'}
      </span>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import type { StickerEnvelopeV1 } from '@/lib/attachment-envelope'
import { loadStickerDisplayUrl } from '@/lib/api/stickers'
import { StickerPreview } from '@/components/chat/sticker-preview'
import type { StickerFormat } from '@/lib/api/stickers'

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
    void loadStickerDisplayUrl(key)
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
  const w = envelope.width && envelope.width > 0 ? Math.min(envelope.width, 200) : 160
  const h = envelope.height && envelope.height > 0 ? Math.min(envelope.height, 200) : 160

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

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: w, height: h }}
    >
      <StickerPreview
        url={url}
        format={envelope.format === 'webp' ? 'static' : (envelope.format as StickerFormat)}
        fallbackEmoji={emoji}
        className="max-h-full max-w-full object-contain"
        onLoadError={() => setErr(true)}
      />
    </div>
  )
}

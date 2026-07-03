'use client'

import { useEffect, useState } from 'react'
import type { StickerEnvelopeV1 } from '@/lib/attachment-envelope'
import { cloneStickerPack, loadStickerDisplayUrl } from '@/lib/api/stickers'
import { StickerPreview } from '@/components/chat/sticker-preview'
import type { StickerFormat } from '@/lib/api/stickers'
import { toastError, toastSuccess } from '@/store/toastStore'

type Props = { envelope: StickerEnvelopeV1 }

export function StickerBubble({ envelope }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloned, setCloned] = useState(false)

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

  const handleClone = async () => {
    if (cloneBusy || cloned) return
    setCloneBusy(true)
    try {
      const res = await cloneStickerPack(envelope.packId)
      setCloned(true)
      toastSuccess(res.already_owned ? 'Already in your collection' : 'Pack added')
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'CLONE_FAILED', { title: 'Stickers' })
    } finally {
      setCloneBusy(false)
    }
  }

  if (err) {
    return (
      <div className="inline-flex flex-col items-center justify-center gap-1 rounded border border-neon-cyan/20 bg-void/60 p-2 text-center font-mono text-[10px] text-danger/90 min-h-[120px] min-w-[120px]">
        <span className="text-lg">{emoji}</span>
        <button
          type="button"
          onClick={handleClone}
          disabled={cloneBusy || cloned}
          className="rounded border border-neon-cyan/40 px-2 py-0.5 text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
        >
          {cloned ? '✓ added' : cloneBusy ? '…' : '+ add pack'}
        </button>
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
        mediaKey={
          envelope.path && !/^https?:/i.test(envelope.path) ? envelope.path : undefined
        }
        fallbackEmoji={emoji}
        className="max-h-full max-w-full object-contain"
        onLoadError={() => setErr(true)}
      />
    </div>
  )
}

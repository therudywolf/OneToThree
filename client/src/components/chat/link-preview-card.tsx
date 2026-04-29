'use client'

import { useEffect, useState } from 'react'
import { fetchLinkPreview, type LinkPreview } from '@/lib/api/link-preview'

type Props = {
  url: string
}

/**
 * Telegram-style link card under a text bubble. Lazy: only renders once
 * the OG metadata resolves; null while loading or if the upstream / SSRF
 * guard refused. Image is rendered with `loading="lazy"` so off-screen
 * cards don't pre-fetch.
 *
 * Privacy posture: the card is fetched through `/api/link-preview` server
 * endpoint, so the upstream never sees the recipient's IP / cookies.
 * Server-side response cache (5 min) plus a client mem-cache (10 min)
 * keep stampede behaviour benign.
 */
export function LinkPreviewCard({ url }: Props) {
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchLinkPreview(url).then((p) => {
      if (cancelled) return
      setPreview(p)
      setResolved(true)
    })
    return () => {
      cancelled = true
    }
  }, [url])

  if (!resolved) return null
  if (!preview) return null
  if (!preview.title && !preview.description && !preview.image) return null

  let host = ''
  try { host = new URL(preview.url).host } catch { /* ignore */ }

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="p13-link-preview mt-1 block max-w-md overflow-hidden rounded border border-border-strong/30 bg-void/40 hover:border-neon-cyan/50 hover:bg-void/60"
    >
      {preview.image ? (
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-32 w-full object-cover"
          referrerPolicy="no-referrer"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : null}
      <div className="space-y-1 px-3 py-2 text-[12px]">
        <div className="text-[10px] uppercase tracking-widest text-text-muted/70">
          {preview.siteName || host}
        </div>
        {preview.title ? (
          <div className="line-clamp-2 font-semibold leading-tight text-[var(--on-surface)]">
            {preview.title}
          </div>
        ) : null}
        {preview.description ? (
          <div className="line-clamp-2 text-text-muted">
            {preview.description}
          </div>
        ) : null}
      </div>
    </a>
  )
}

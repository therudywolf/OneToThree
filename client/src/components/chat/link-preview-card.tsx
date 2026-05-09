'use client'

import { useEffect, useState } from 'react'
import { fetchLinkPreview, type LinkPreview } from '@/lib/api/link-preview'

type Props = {
  url: string
}

/**
 * Sprint M1-9 — recognize embeddable video hosts and return an iframe
 * embed URL. We deliberately gate this to a tiny allowlist (YouTube,
 * Vimeo) — third-party iframes are a privacy leak surface, so the card
 * keeps the OG-only fallback for everything else.
 *
 * The OG fetch still runs through our SSRF-guarded proxy; only the
 * eventual <iframe> hits the upstream directly when the user has the
 * card on screen.
 */
function detectVideoEmbed(raw: string): { src: string; title: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()

  // YouTube — long-form watch?v=, shorts/, youtu.be short links
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0]
    if (/^[\w-]{6,}$/.test(id)) {
      return { src: `https://www.youtube.com/embed/${id}`, title: 'YouTube' }
    }
  }
  if (
    host === 'www.youtube.com' ||
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host === 'www.youtube-nocookie.com'
  ) {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v')
      if (id && /^[\w-]{6,}$/.test(id)) {
        return { src: `https://www.youtube.com/embed/${id}`, title: 'YouTube' }
      }
    }
    const m = u.pathname.match(/^\/(?:embed|shorts)\/([\w-]{6,})/)
    if (m) return { src: `https://www.youtube.com/embed/${m[1]}`, title: 'YouTube' }
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const id = u.pathname.replace(/^\//, '').split('/')[0]
    if (/^\d{5,}$/.test(id)) {
      return { src: `https://player.vimeo.com/video/${id}`, title: 'Vimeo' }
    }
  }
  if (host === 'player.vimeo.com') {
    const m = u.pathname.match(/^\/video\/(\d{5,})/)
    if (m) return { src: `https://player.vimeo.com/video/${m[1]}`, title: 'Vimeo' }
  }

  return null
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
  const [embedRevealed, setEmbedRevealed] = useState(false)
  const embed = detectVideoEmbed(url)

  useEffect(() => {
    if (embed) {
      setResolved(true)
      return
    }
    let cancelled = false
    void fetchLinkPreview(url).then((p) => {
      if (cancelled) return
      setPreview(p)
      setResolved(true)
    })
    return () => {
      cancelled = true
    }
  }, [url, embed])

  // Sprint M1-9 — YouTube / Vimeo inline player. Click-to-load so a chat
  // with 30 video links doesn't auto-spawn 30 iframes (perf + privacy).
  if (embed) {
    return (
      <div className="mt-1 max-w-md overflow-hidden rounded border border-border-strong/30 bg-void/40">
        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-widest text-text-muted/70">
          <span>{embed.title}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neon-cyan/70 hover:text-neon-cyan"
          >
            open ↗
          </a>
        </div>
        {embedRevealed ? (
          <div className="aspect-video w-full">
            <iframe
              src={embed.src}
              title={embed.title}
              loading="lazy"
              allowFullScreen
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
              allow="autoplay; encrypted-media; picture-in-picture"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEmbedRevealed(true)}
            className="flex aspect-video w-full items-center justify-center bg-void/60 text-[11px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-void/80"
          >
            ▶ play {embed.title}
          </button>
        )}
      </div>
    )
  }

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
          onError={(e) => {
            const img = e.target as HTMLImageElement
            img.style.display = 'none'
            // Sprint M1-9 — replace failed thumbnail with a neutral host stripe.
            const fallback = img.nextElementSibling as HTMLElement | null
            if (fallback) fallback.style.display = 'flex'
          }}
        />
      ) : null}
      <div
        style={{ display: 'none' }}
        className="h-10 w-full items-center justify-center bg-surface/30 text-[11px] uppercase tracking-widest text-text-muted/70"
      >
        🔗 {host}
      </div>
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

'use client'

import React, { useMemo, useState, useCallback } from 'react'
import emojiRegex from 'emoji-regex'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { sanitizeText } from '@/lib/sanitize'
import { API_URL } from '@/lib/api/auth'

type Props = {
  text: string
  className?: string
}

/** Match ```lang\ncode\n``` blocks */
const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g
/** Match inline `code` */
const INLINE_CODE_RE = /`([^`\n]+)`/g
/** URL regex */
const URL_RE = /https?:\/\/[^\s<>)"'\]]+/g

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [code])

  return (
    <div className="code-block group relative my-1">
      {lang ? (
        <span className="absolute left-2 top-1 font-mono text-[8px] uppercase tracking-widest text-neon-cyan/40">
          {lang}
        </span>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          handleCopy()
        }}
        className="copy-btn opacity-0 transition-opacity group-hover:opacity-100"
      >
        {copied ? (
          <span className="inline-flex items-center gap-1 text-neon-cyan">
            <Check className="h-2.5 w-2.5" />
            {t('code.copied')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Copy className="h-2.5 w-2.5" />
            {t('code.copy')}
          </span>
        )}
      </button>
      <pre className="overflow-x-auto whitespace-pre text-[11px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function InlineCode({ code }: { code: string }) {
  return (
    <code className="p13-inline-code border border-neon-cyan/20 bg-void/70 px-1 py-0.5 font-mono text-[11px] text-neon-cyan/80">
      {code}
    </code>
  )
}

function LinkPreviewCard({ url }: { url: string }) {
  const [meta, setMeta] = useState<{ title?: string; description?: string; image?: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  React.useEffect(() => {
    if (loaded) return
    setLoaded(true)
    // Attempt to fetch OG meta via a lightweight proxy/api — gracefully degrade
    const controller = new AbortController()
    void fetch(`${API_URL}/link-preview?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && (d.title || d.description || d.image)) {
          setMeta(d as { title?: string; description?: string; image?: string })
        }
      })
      .catch(() => { /* graceful degrade — no preview */ })
    return () => controller.abort()
  }, [url, loaded])

  if (!meta) return null

  return (
    <div className="mt-1 flex gap-2 border border-neon-cyan/20 bg-void/80 p-2 max-w-xs">
      {meta.image ? (
        <img
          src={meta.image}
          alt=""
          className="h-12 w-12 shrink-0 object-cover border border-neon-cyan/10"
          loading="lazy"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        {meta.title ? (
          <p className="truncate font-mono text-[10px] text-neon-cyan/80">{meta.title}</p>
        ) : null}
        {meta.description ? (
          <p className="line-clamp-2 font-mono text-[8px] text-text-muted leading-relaxed">{meta.description}</p>
        ) : null}
      </div>
    </div>
  )
}

function LinkSpan({ url }: { url: string }) {
  // Trim trailing punctuation that's likely not part of URL
  const cleanUrl = url.replace(/[.,;:!?)]+$/, '')
  const domain = (() => {
    try {
      return new URL(cleanUrl).hostname
    } catch {
      return cleanUrl
    }
  })()

  return (
    <span className="inline">
      <a
        href={cleanUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-neon-cyan/80 underline decoration-neon-cyan/30 underline-offset-2 transition-colors hover:text-neon-cyan hover:decoration-neon-cyan/60"
        title={domain}
      >
        {cleanUrl}
      </a>
      <LinkPreviewCard url={cleanUrl} />
    </span>
  )
}

export function NoirPlaintext({ text, className = '' }: Props) {
  const processedNodes = useMemo(() => {
    const safeText = sanitizeText(text)
    const _emojiRe = emojiRegex()

    // First, split out code blocks
    const segments: React.ReactNode[] = []
    let lastIdx = 0
    let nodeKey = 0

    const codeBlocks: Array<{ start: number; end: number; lang?: string; code: string }> = []
    let cbMatch: RegExpExecArray | null
    const cbRe = new RegExp(CODE_BLOCK_RE.source, 'g')
    while ((cbMatch = cbRe.exec(safeText)) !== null) {
      codeBlocks.push({
        start: cbMatch.index,
        end: cbMatch.index + cbMatch[0].length,
        lang: cbMatch[1],
        code: cbMatch[2],
      })
    }

    const processInlineText = (chunk: string): React.ReactNode[] => {
      const nodes: React.ReactNode[] = []
      // Split by inline code, then URLs, then emoji
      let _remaining = chunk
      let _cursor = 0

      // Find all inline code spans
      const inlineMatches: Array<{ start: number; end: number; code: string }> = []
      const inRe = new RegExp(INLINE_CODE_RE.source, 'g')
      let inMatch: RegExpExecArray | null
      while ((inMatch = inRe.exec(chunk)) !== null) {
        inlineMatches.push({
          start: inMatch.index,
          end: inMatch.index + inMatch[0].length,
          code: inMatch[1],
        })
      }

      // Find all URLs
      const urlMatches: Array<{ start: number; end: number; url: string }> = []
      const urlRe = new RegExp(URL_RE.source, 'g')
      let urlMatch: RegExpExecArray | null
      while ((urlMatch = urlRe.exec(chunk)) !== null) {
        // Don't match URLs inside inline code
        const inCode = inlineMatches.some(
          (ic) => urlMatch!.index >= ic.start && urlMatch!.index < ic.end,
        )
        if (!inCode) {
          urlMatches.push({
            start: urlMatch.index,
            end: urlMatch.index + urlMatch[0].length,
            url: urlMatch[0],
          })
        }
      }

      // Merge and sort all special ranges
      const specials = [
        ...inlineMatches.map((m) => ({ ...m, type: 'code' as const })),
        ...urlMatches.map((m) => ({ ...m, type: 'url' as const })),
      ].sort((a, b) => a.start - b.start)

      let pos = 0
      for (const s of specials) {
        if (s.start < pos) continue // overlapping, skip

        // Plain text before this special
        if (s.start > pos) {
          const plain = chunk.slice(pos, s.start)
          nodes.push(...processEmojiText(plain))
        }

        if (s.type === 'code') {
          nodes.push(<InlineCode key={`ic-${nodeKey++}`} code={s.code} />)
        } else {
          nodes.push(<LinkSpan key={`url-${nodeKey++}`} url={s.url} />)
        }
        pos = s.end
      }

      // Remaining plain text
      if (pos < chunk.length) {
        nodes.push(...processEmojiText(chunk.slice(pos)))
      }

      return nodes
    }

    const processEmojiText = (plain: string): React.ReactNode[] => {
      const nodes: React.ReactNode[] = []
      const re = emojiRegex()
      let last = 0

      for (const match of plain.matchAll(re)) {
        const emoji = match[0]
        const index = match.index ?? 0

        if (index > last) {
          nodes.push(plain.slice(last, index))
        }

        nodes.push(
          <span
            key={`emoji-${nodeKey++}`}
            className="noir-emoji-inline"
            aria-hidden="false"
          >
            {emoji}
          </span>,
        )
        last = index + emoji.length
      }

      if (last < plain.length) {
        nodes.push(plain.slice(last))
      }

      return nodes
    }

    // Process text with code blocks
    if (codeBlocks.length === 0) {
      return processInlineText(safeText)
    }

    for (const cb of codeBlocks) {
      // Plain text before code block
      if (cb.start > lastIdx) {
        segments.push(...processInlineText(safeText.slice(lastIdx, cb.start)))
      }

      segments.push(
        <CodeBlock key={`cb-${nodeKey++}`} code={cb.code} lang={cb.lang} />,
      )
      lastIdx = cb.end
    }

    // Remaining text after last code block
    if (lastIdx < safeText.length) {
      segments.push(...processInlineText(safeText.slice(lastIdx)))
    }

    return segments
  }, [text])

  return <span className={className}>{processedNodes}</span>
}

'use client'

import { useEffect, useState } from 'react'
import { fetchChatAvatarDownloadUrl } from '@/lib/api/avatar'

/**
 * Picture of a group/channel, with an initials tile as the fallback.
 *
 * Deliberately NOT routed through `avatar-cache`: that registry is keyed by
 * user id, and a chat id colliding into the same map would hand a room the
 * wrong picture. Chat avatars change rarely and the presigned URL response is
 * already cached for ~30 minutes by the browser, so a small per-mount fetch is
 * cheap enough to keep the two namespaces apart.
 */

function hashToHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) & 0xffff
  }
  return h % 360
}

function initialsFrom(name: string): string {
  const t = name.trim()
  if (!t) return '#'
  const parts = t.split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  }
  return t.slice(0, 2).toUpperCase()
}

export function ChatAvatar({
  chatId,
  name,
  avatarKey,
  size = 28,
  square = false,
  className = '',
}: {
  chatId: string
  name: string
  avatarKey?: string | null
  size?: number
  /** Square tile (chat list) vs round (headers, cards). */
  square?: boolean
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!avatarKey?.trim()) {
      setUrl(null)
      return
    }
    let cancelled = false
    void fetchChatAvatarDownloadUrl(chatId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [chatId, avatarKey])

  const px = `${size}px`
  const radius = square ? 'rounded-md' : 'rounded-full'

  if (url) {
    return (
      <span
        className={`inline-flex shrink-0 overflow-hidden border border-neon-cyan/60 ${radius} ${className}`}
        style={{ width: px, height: px }}
      >
        <img src={url} alt="" className="h-full w-full object-cover" />
      </span>
    )
  }

  const hue = hashToHue(name || chatId)
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border border-neon-cyan/40 font-mono text-[0.5em] font-bold uppercase leading-none ${radius} ${className}`}
      style={{
        width: px,
        height: px,
        background: `linear-gradient(135deg, hsl(${hue},50%,28%), hsl(${(hue + 45) % 360},45%,20%))`,
        color: 'rgba(255,255,255,0.92)',
      }}
      aria-hidden
    >
      {initialsFrom(name || chatId)}
    </span>
  )
}

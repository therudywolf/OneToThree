'use client'

import { useEffect, useState } from 'react'
import { getCachedAvatarUrl, invalidateAvatarCache } from '@/lib/avatar-cache'

function initialsFrom(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  const parts = t.split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  }
  return t.slice(0, 2).toUpperCase()
}

export function UserAvatar({
  userId,
  username,
  avatarKey,
  size = 28,
  className = '',
}: {
  userId: string
  username: string
  avatarKey?: string | null
  size?: number
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!avatarKey?.trim()) {
      setUrl(null)
      setErr(false)
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const cachedUrl = await getCachedAvatarUrl(userId)
        if (!cancelled) {
          setUrl(cachedUrl)
          setErr(!cachedUrl) // Set error if no avatar was found
        }
      } catch {
        if (!cancelled) setErr(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId, avatarKey])

  const px = `${size}px`
  const label = initialsFrom(username)

  if (url && !err) {
    return (
      <span
        className={`inline-flex shrink-0 overflow-hidden rounded-full border border-neon-cyan/70 shadow-[0_0_8px_rgba(0,255,255,0.15)] ${className}`}
        style={{ width: px, height: px }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="h-full w-full object-cover" />
      </span>
    )
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-neon-cyan/70 bg-black font-mono text-[0.55em] font-bold uppercase leading-none text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.12)] ${className}`}
      style={{ width: px, height: px }}
      aria-hidden
    >
      {label}
    </span>
  )
}

'use client'

import { useEffect, useRef } from 'react'
import { Pin, PinOff, Star, StarOff, Bell, BellOff, Eye, EyeOff, Archive, ArchiveRestore } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import { getChatPrivacy, setChatPrivacyOverride } from '@/lib/chat-privacy'

export type ChatRowContextMenuProps = {
  x: number
  y: number
  chatId: string
  isPinned: boolean
  isFavorite: boolean
  isMuted: boolean
  isArchived?: boolean
  onPin: () => void
  onFavorite: () => void
  onMute: () => void
  onArchive?: () => void
  onClose: () => void
}

export function ChatRowContextMenu({
  x,
  y,
  chatId,
  isPinned,
  isFavorite,
  isMuted,
  isArchived = false,
  onPin,
  onFavorite,
  onMute,
  onArchive,
  onClose,
}: ChatRowContextMenuProps) {
  const privacy = getChatPrivacy(chatId)
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode) === 'md3'
  const menuRef = useRef<HTMLDivElement>(null)
  const MENU_MIN_WIDTH = 220
  const VIEWPORT_MARGIN = 8

  useEffect(() => {
    function handleDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('touchstart', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('touchstart', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Keep menu inside viewport so labels/buttons are never clipped.
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
  const clampedLeft =
    viewportWidth > 0
      ? Math.max(VIEWPORT_MARGIN, Math.min(x, viewportWidth - MENU_MIN_WIDTH - VIEWPORT_MARGIN))
      : x
  const estimatedMenuHeight = 3 * 44 + 8
  const clampedTop =
    viewportHeight > 0
      ? Math.max(VIEWPORT_MARGIN, Math.min(y, viewportHeight - estimatedMenuHeight - VIEWPORT_MARGIN))
      : y

  const style: React.CSSProperties = {
    position: 'fixed',
    left: clampedLeft,
    top: clampedTop,
    zIndex: 9999,
  }

  const items = [
    {
      icon: isPinned ? PinOff : Pin,
      label: isPinned ? t('sidebar.unpin') : t('sidebar.pin'),
      action: onPin,
      active: isPinned,
    },
    {
      icon: isFavorite ? StarOff : Star,
      label: isFavorite ? t('sidebar.unfavorite') : t('sidebar.favorite'),
      action: onFavorite,
      active: isFavorite,
    },
    {
      icon: isMuted ? Bell : BellOff,
      label: isMuted ? t('sidebar.unmute') : t('sidebar.mute'),
      action: onMute,
      active: isMuted,
    },
    ...(onArchive
      ? [
          {
            icon: isArchived ? ArchiveRestore : Archive,
            label: isArchived ? 'Unarchive' : 'Archive',
            action: onArchive,
            active: isArchived,
          },
        ]
      : []),
    {
      icon: privacy.noCopy ? EyeOff : Eye,
      label: privacy.noCopy ? 'Privacy: copy ON' : 'Privacy: block copy',
      action: () => setChatPrivacyOverride(chatId, { ...privacy, noCopy: !privacy.noCopy }),
      active: privacy.noCopy,
    },
    {
      icon: privacy.blankOnBlur ? EyeOff : Eye,
      label: privacy.blankOnBlur ? 'Privacy: blur OFF' : 'Privacy: blur on blur',
      action: () => setChatPrivacyOverride(chatId, { ...privacy, blankOnBlur: !privacy.blankOnBlur }),
      active: privacy.blankOnBlur,
    },
  ]

  if (isMd3) {
    return (
      <div
        ref={menuRef}
        style={style}
        className="min-w-[220px] max-w-[min(92vw,280px)] overflow-hidden rounded-xl bg-[var(--surface-container-high)] py-1 shadow-[var(--md3-elevation-3)]"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--state-hover)] ${
              item.active ? 'text-[var(--primary)]' : 'text-[var(--on-surface)]'
            }`}
            onClick={() => {
              item.action()
              onClose()
            }}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="whitespace-normal break-words leading-5">{item.label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={menuRef}
      style={style}
      className="min-w-[220px] max-w-[min(92vw,300px)] border border-neon-cyan/30 bg-void font-mono shadow-[0_4px_24px_rgba(0,0,0,0.8)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] uppercase tracking-widest transition-colors hover:bg-neon-cyan/10 ${
            item.active ? 'text-neon-cyan' : 'text-text-muted hover:text-neon-cyan'
          }`}
          onClick={() => {
            item.action()
            onClose()
          }}
        >
          <item.icon className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-normal break-words leading-4">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

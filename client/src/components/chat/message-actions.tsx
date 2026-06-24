'use client'

import { useRef, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Reply,
  SmilePlus,
  Pencil,
  Trash2,
  Forward,
  Copy,
  Pin,
  PinOff,
} from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type { DecryptedMessage } from '@/types/chat'
import { useThemeStore } from '@/store/themeStore'
import { parseStickerEnvelope } from '@/lib/attachment-envelope'
import { QUICK_REACTIONS, addRecentlyUsed } from '@/lib/quick-reactions'
import { toastInfo } from '@/store/toastStore'

type Action =
  | 'reply'
  | 'react'
  | 'saveToMine'
  | 'edit'
  | 'deleteForMe'
  | 'deleteForAll'
  | 'forward'
  | 'copy'
  | 'pin'

type Props = {
  message: DecryptedMessage
  isMine: boolean
  isPinned?: boolean
  position: { x: number; y: number }
  onAction: (action: Action) => void
  onClose: () => void
}

export function MessageActions({
  message,
  isMine,
  isPinned = false,
  position,
  onAction,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const menuRef = useRef<HTMLDivElement>(null)
  const [dangerConfirmKey, setDangerConfirmKey] = useState<Action | null>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  useEffect(() => {
    if (!dangerConfirmKey) return
    const timer = window.setTimeout(() => setDangerConfirmKey(null), 2500)
    return () => window.clearTimeout(timer)
  }, [dangerConfirmKey])

  const actions: Array<{
    key: Action
    label: string
    icon: typeof Reply
    show: boolean
    danger?: boolean
  }> = [
    {
      key: 'saveToMine',
      label: (() => {
        const sticker = parseStickerEnvelope(message.plaintext)
        return sticker ? t('msgAction.addStickerPack') : t('msgAction.addGifFavorite')
      })(),
      icon: Copy,
      show: (() => {
        if (parseStickerEnvelope(message.plaintext)) return true
        const mediaPath = message.media_path?.toLowerCase() ?? ''
        if (mediaPath.endsWith('.gif')) return true
        const plain = message.plaintext?.toLowerCase() ?? ''
        return plain.includes('.gif') || plain.includes('giphy.com') || plain.includes('media.tenor.com')
      })(),
    },
    { key: 'reply', label: t('msgAction.reply'), icon: Reply, show: true },
    { key: 'react', label: t('msgAction.react'), icon: SmilePlus, show: true },
    {
      key: 'copy',
      label: t('msgAction.copy'),
      icon: Copy,
      show: !!message.plaintext,
    },
    // Edit: only the sender can edit their own text messages.
    { key: 'edit', label: t('msgAction.edit'), icon: Pencil, show: isMine && !!message.plaintext },
    // Forward: client-side re-encryption under the target chat's crypto context
    // (see `handleForward` in chat-terminal.tsx). No dedicated server endpoint —
    // the standard `/messages/send` pipeline handles it because forwarding is
    // just "send this plaintext to another chat". Enabled for non-empty text.
    {
      key: 'forward',
      label: t('msgAction.forward'),
      icon: Forward,
      show: !!message.plaintext,
    },
    {
      key: 'pin',
      label: isPinned ? t('msgAction.unpin') : t('msgAction.pin'),
      icon: isPinned ? PinOff : Pin,
      show: true,
    },
    {
      key: 'deleteForMe',
      label: t('msgAction.deleteForMe'),
      icon: Trash2,
      show: true,
      danger: true,
    },
    {
      key: 'deleteForAll',
      label: t('msgAction.deleteForAll'),
      icon: Trash2,
      show: isMine,
      danger: true,
    },
  ]
  // Undecryptable rows ([DECRYPT_FAIL]) cannot be safely interacted with:
  // forwarding/replying/reacting/pinning/deleting-for-all all reference a
  // payload that no participant can read. Only "delete for me" (local hide)
  // and "delete for all" (own message removal) make sense.
  const isUndecryptable = message.plaintext === '[DECRYPT_FAIL]'
  const visibleActions = actions.filter((a) => {
    if (!a.show) return false
    if (isUndecryptable && a.key !== 'deleteForMe' && a.key !== 'deleteForAll') return false
    return true
  })
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 400
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 400
  const compactViewport = viewportWidth < 640
  const menuWidth = compactViewport ? Math.min(260, viewportWidth - 16) : 216
  const menuHeight = Math.min(420, visibleActions.length * 42 + 20)
  const x = compactViewport
    ? 8
    : Math.min(Math.max(8, position.x), viewportWidth - menuWidth - 8)
  const y = Math.min(Math.max(8, position.y), viewportHeight - menuHeight - 8)

  return (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        className={`fixed z-[120] w-[min(16rem,calc(100vw-1rem))] max-w-[16rem] py-1 ${
          isMd3
            ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_14%,transparent)] bg-[var(--surface-elevated)] shadow-[var(--md3-elevation-3)]'
            : isRetro
              ? 'p13-classic-menu shadow-[0_6px_14px_rgba(0,0,0,0.24)]'
              : 'border border-neon-cyan/60 bg-void shadow-[0_0_24px_rgba(0,255,255,0.1)]'
        }`}
        role="menu"
        aria-label={t('chat.contextMenuAria')}
        style={{ left: x, top: y }}
      >
        {visibleActions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  isMd3
                    ? action.danger
                      ? 'rounded-xl text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
                      : 'rounded-xl text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                    : isRetro
                      ? action.danger
                        ? 'p13-classic-menu-item p13-classic-menu-item--danger'
                        : 'p13-classic-menu-item'
                      : action.danger
                        ? 'font-mono text-[10px] uppercase tracking-widest text-danger hover:bg-neon-red/10 hover:text-neon-red'
                        : 'font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (action.danger && dangerConfirmKey !== action.key) {
                    setDangerConfirmKey(action.key)
                    return
                  }
                  // D17 — pin/unpin has no visible surface, so confirm the
                  // action with a toast (the pinned list itself has no UI yet).
                  if (action.key === 'pin') {
                    toastInfo(isPinned ? t('msgAction.unpinned') : t('msgAction.pinned'))
                  }
                  onAction(action.key)
                  onClose()
                }}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {action.danger && dangerConfirmKey === action.key
                  ? `${t('common.confirm')}: ${action.label}`
                  : action.label}
              </button>
            )
          })}
      </motion.div>
    </AnimatePresence>
  )
}

/**
 * Quick-reaction bar: shown on hover (desktop) or alongside action menu.
 * Shows the first 5 of the shared QUICK_REACTIONS set for quick tap reaction.
 */
const HOVER_BAR_EMOJIS = QUICK_REACTIONS.slice(0, 5)

type QuickReactProps = {
  onReact: (emoji: string) => void
}

export function QuickReactBar({ onReact }: QuickReactProps) {
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  return (
    <div
      className={`flex items-center gap-0.5 px-1 py-0.5 ${
        isMd3
          ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,var(--surface))] shadow-[var(--md3-elevation-2)]'
        : isRetro
            ? 'p13-classic-menu'
            : 'border border-neon-cyan/40 bg-void shadow-[0_0_12px_rgba(0,255,255,0.08)]'
      }`}
    >
      {HOVER_BAR_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            addRecentlyUsed(emoji)
            onReact(emoji)
          }}
          className={`flex h-7 w-7 items-center justify-center text-base transition-transform active:scale-95 ${
            isMd3
              ? 'rounded-full hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] hover:scale-110'
              : isRetro
                ? 'p13-classic-react-btn hover:scale-105'
                : 'hover:scale-125'
          }`}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

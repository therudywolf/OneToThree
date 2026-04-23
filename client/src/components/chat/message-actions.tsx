'use client'

import { useRef, useEffect } from 'react'
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

type Action =
  | 'reply'
  | 'react'
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

  // Clamp position to viewport
  const menuWidth = 200
  const menuHeight = 320
  const x = Math.min(
    Math.max(8, position.x),
    (typeof window !== 'undefined' ? window.innerWidth : 400) - menuWidth - 8,
  )
  const y = Math.min(
    Math.max(8, position.y),
    (typeof window !== 'undefined' ? window.innerHeight : 400) - menuHeight - 8,
  )

  const actions: Array<{
    key: Action
    label: string
    icon: typeof Reply
    show: boolean
    danger?: boolean
  }> = [
    { key: 'reply', label: t('msgAction.reply'), icon: Reply, show: true },
    { key: 'react', label: t('msgAction.react'), icon: SmilePlus, show: true },
    {
      key: 'copy',
      label: t('msgAction.copy'),
      icon: Copy,
      show: !!message.plaintext,
    },
    // Edit hidden until the server `PATCH /messages/:id` endpoint exists and
    // the client knows how to re-encrypt under the current chat transport.
    // The composer-side infra (`editingMessage` in chatStore, edit banner)
    // is already in place so toggling `show: true` will light it up.
    { key: 'edit', label: t('msgAction.edit'), icon: Pencil, show: false },
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

  return (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        className={`fixed z-[120] min-w-[12rem] py-1 ${
          isMd3
            ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_14%,transparent)] bg-[var(--surface-elevated)] shadow-[var(--md3-elevation-3)]'
            : isRetro
              ? 'border border-[#6f747c] bg-[#d4d0c8] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff,0_6px_14px_rgba(0,0,0,0.24)]'
              : 'border border-neon-cyan/60 bg-void shadow-[0_0_24px_rgba(0,255,255,0.1)]'
        }`}
        role="menu"
        aria-label={t('chat.contextMenuAria')}
        style={{ left: x, top: y }}
      >
        {actions
          .filter((a) => a.show)
          .map((action) => {
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
                        ? 'font-["Tahoma"] text-[11px] text-[#8f1f23] hover:bg-[#eadfdc]'
                        : 'font-["Tahoma"] text-[11px] text-[#1e2f44] hover:bg-[#e8e4dc]'
                      : action.danger
                        ? 'font-mono text-[10px] uppercase tracking-widest text-danger hover:bg-neon-red/10 hover:text-neon-red'
                        : 'font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  onAction(action.key)
                  onClose()
                }}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {action.label}
              </button>
            )
          })}
      </motion.div>
    </AnimatePresence>
  )
}

/**
 * Quick-reaction bar: shown on hover (desktop) or alongside action menu.
 * Shows 5 most-used emoji for quick tap reaction.
 */
const QUICK_REACTIONS = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F44E}']

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
            ? 'border border-[#6f747c] bg-[#d4d0c8] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
            : 'border border-neon-cyan/40 bg-void shadow-[0_0_12px_rgba(0,255,255,0.08)]'
      }`}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onReact(emoji)
          }}
          className={`flex h-7 w-7 items-center justify-center text-base transition-transform active:scale-95 ${
            isMd3
              ? 'rounded-full hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] hover:scale-110'
              : isRetro
                ? 'rounded-none border border-transparent hover:border-[#9aa0aa] hover:bg-[#ece9e2] hover:scale-105'
                : 'hover:scale-125'
          }`}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

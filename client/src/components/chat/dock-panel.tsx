'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useDockStore } from '@/store/dockStore'
import { useTranslation } from '@/hooks/use-translation'
import EmojiPicker, { Theme } from 'emoji-picker-react'
import { ShellSurface, ShellText, ShellIconButton, useShell } from '@/components/ui/shell'

/**
 * DockPanel — right-side slide-in panel on xl+ screens. Hosts profile,
 * emoji picker, per-chat search, and pinned-messages list. On narrower
 * screens consumers should open a modal instead (see `matchesDockViewport`
 * in the dock store).
 */

const UserProfileModal = dynamic(
  () =>
    import('@/components/chat/user-profile-modal').then(
      (m) => m.UserProfileModal
    ),
  { ssr: false }
)

export function DockPanel() {
  const { t } = useTranslation()
  const { isTerminal } = useShell()
  const slot = useDockStore((s) => s.slot)
  const close = useDockStore((s) => s.close)
  const profileUserId = useDockStore((s) => s.profileUserId)
  const emojiOnPick = useDockStore((s) => s.emojiOnPick)

  useEffect(() => {
    if (!slot) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slot, close])

  if (!slot) return null

  return (
    <ShellSurface
      variant="panel"
      className={`chat-dock-panel relative flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden ${
        isTerminal
          ? 'border-l border-neon-cyan/40 bg-void'
          : 'border-l border-[var(--md3-surface-variant,rgba(255,255,255,0.08))] bg-[var(--surface,#111)]'
      }`}
      role="complementary"
      aria-label={t('dock.panelAria')}
    >
      <header
        className={`flex shrink-0 items-center justify-between gap-2 px-3 py-2 ${
          isTerminal ? 'border-b border-neon-cyan/30' : 'border-b border-[var(--md3-outline-variant,rgba(255,255,255,0.08))]'
        }`}
      >
        <ShellText variant="label" className="truncate">
          {slot === 'profile' && t('dock.profileTitle')}
          {slot === 'emoji' && t('emoji.pickerTitle')}
          {slot === 'search' && t('dock.searchTitle')}
          {slot === 'pinned' && t('dock.pinnedTitle')}
        </ShellText>
        <ShellIconButton
          tone="ghost"
          aria-label={t('common.close')}
          onClick={close}
        >
          <X className="h-4 w-4" aria-hidden />
        </ShellIconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {slot === 'profile' && profileUserId ? (
          // Profile slot temporarily renders the legacy modal at the bottom
          // of the screen. Replacing it with a dock-native profile view is
          // tracked separately — for now this keeps the dock wiring exercised
          // without duplicating all the tabs/media panels of UserProfileModal.
          <UserProfileModal
            userId={profileUserId}
            username={''}
            avatarKey={null}
            onClose={close}
            onMessage={close}
          />
        ) : null}

        {slot === 'emoji' ? (
          <div className="p-2">
            <EmojiPicker
              onEmojiClick={(data) => {
                emojiOnPick?.(data.emoji)
              }}
              skinTonesDisabled
              previewConfig={{ showPreview: false }}
              width="100%"
              height={420}
              theme={isTerminal ? Theme.DARK : Theme.AUTO}
            />
          </div>
        ) : null}

        {slot === 'search' ? (
          <div className="p-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
            {t('dock.searchComingSoon')}
          </div>
        ) : null}

        {slot === 'pinned' ? (
          <div className="p-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
            {t('dock.pinnedComingSoon')}
          </div>
        ) : null}
      </div>
    </ShellSurface>
  )
}

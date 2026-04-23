'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import dynamic from 'next/dynamic'
import { Theme } from 'emoji-picker-react'
import { useDockStore } from '@/store/dockStore'
import { useTranslation } from '@/hooks/use-translation'
import { useLocaleStore } from '@/store/localeStore'
import { ShellSurface, ShellText, ShellIconButton, useShell } from '@/components/ui/shell'
import { ChatSearchPanel } from '@/components/chat/chat-search-panel'
import { ComposerPickerPanel } from '@/components/chat/composer-picker-panel'
import { lookupUsers } from '@/lib/api/users'
import { UserAvatar } from '@/components/user-avatar'

const LazyEmojiPicker = dynamic(
  () => import('emoji-picker-react').then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[420px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
        loading…
      </div>
    ),
  }
)

/**
 * DockPanel — right-side slide-in panel on xl+ screens. Hosts profile,
 * emoji picker, per-chat search, and pinned-messages list. On narrower
 * screens consumers should open a modal instead (see `matchesDockViewport`
 * in the dock store).
 */

export function DockPanel() {
  const { t } = useTranslation()
  const { isTerminal } = useShell()
  const locale = useLocaleStore((s) => s.module)
  const slot = useDockStore((s) => s.slot)
  const close = useDockStore((s) => s.close)
  const profileUserId = useDockStore((s) => s.profileUserId)
  const emojiOnPick = useDockStore((s) => s.emojiOnPick)
  const composerOnEmoji = useDockStore((s) => s.composerOnEmoji)
  const composerOnStickerSend = useDockStore((s) => s.composerOnStickerSend)
  const composerOnGifPick = useDockStore((s) => s.composerOnGifPick)
  const searchOnJump = useDockStore((s) => s.searchOnJump)
  const [profileSummary, setProfileSummary] = useState<{ id: string; username: string; avatar_key: string | null } | null>(null)

  useEffect(() => {
    if (slot === 'profile' && !profileUserId) {
      close()
      return
    }
    if (slot !== 'profile' || !profileUserId) {
      setProfileSummary(null)
      return
    }
    let cancelled = false
    void lookupUsers([profileUserId])
      .then((rows) => {
        if (cancelled) return
        const row = rows[0]
        setProfileSummary(row ? { id: row.id, username: row.username, avatar_key: row.avatar_key ?? null } : null)
      })
      .catch(() => {
        if (!cancelled) setProfileSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [slot, profileUserId])

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
          {slot === 'composer' && t('composer.pickerTitle')}
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
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className={`rounded-2xl border p-3 ${
              isTerminal
                ? 'border-neon-cyan/30 bg-void/70'
                : 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]'
            }`}>
              {profileSummary ? (
                <div className="flex items-center gap-3">
                  <UserAvatar
                    userId={profileSummary.id}
                    username={profileSummary.username}
                    avatarKey={profileSummary.avatar_key}
                    size={42}
                  />
                  <div className="min-w-0">
                    <p className={`truncate text-sm font-semibold ${isTerminal ? 'text-neon-cyan' : 'text-[var(--on-surface)]'}`}>
                      {profileSummary.username}
                    </p>
                    <p className={`truncate text-xs ${isTerminal ? 'text-neon-cyan/70' : 'text-text-muted'}`}>
                      ID: {profileSummary.id}
                    </p>
                  </div>
                </div>
              ) : (
                <p className={`text-xs ${isTerminal ? 'text-neon-cyan/70' : 'text-text-muted'}`}>
                  {t('common.loading')}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {slot === 'emoji' ? (
          <div className="p13-epr-host p-2">
            <LazyEmojiPicker
              onEmojiClick={(data: { emoji: string }) => {
                emojiOnPick?.(data.emoji)
              }}
              skinTonesDisabled
              previewConfig={{ showPreview: false }}
              width="100%"
              height={420}
              theme={isTerminal ? Theme.DARK : Theme.LIGHT}
            />
          </div>
        ) : null}

        {slot === 'composer' && composerOnEmoji && composerOnStickerSend ? (
          <ComposerPickerPanel
            layout="dock"
            onEmoji={(e) => composerOnEmoji(e)}
            onStickerSend={composerOnStickerSend}
            onGifPick={composerOnGifPick ?? undefined}
          />
        ) : null}

        {slot === 'search' ? (
          <ChatSearchPanel
            locale={locale}
            onJumpToMessage={(id) => {
              searchOnJump?.(id)
            }}
          />
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

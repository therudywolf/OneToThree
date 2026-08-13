'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useDockStore } from '@/store/dockStore'
import { useTranslation } from '@/hooks/use-translation'
import { useLocaleStore } from '@/store/localeStore'
import { ShellSurface, ShellText, ShellIconButton, useShell } from '@/components/ui/shell'
import { ChatSearchPanel } from '@/components/chat/chat-search-panel'
import { ComposerPickerPanel } from '@/components/chat/composer-picker-panel'
import { ChatEmojiPicker } from '@/components/chat/chat-emoji-picker'
import { lookupUsers, fetchUserProfile, type UserProfile } from '@/lib/api/users'
import { UserAvatar } from '@/components/user-avatar'
import { ChatAvatar } from '@/components/chat-avatar'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { useSessionStore } from '@/store/sessionStore'
import { sanitizeText, sanitizeUrl } from '@/lib/sanitize'
import { Megaphone } from 'lucide-react'

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
  // The dock used to stop at avatar + handle + id, so the SAME profile was rich
  // in the modal on a narrow window and a stub on a wide one. Pull the full
  // card here too.
  const [profileFull, setProfileFull] = useState<UserProfile | null>(null)

  useEffect(() => {
    if (slot === 'profile' && !profileUserId) {
      close()
      return
    }
    if (slot !== 'profile' || !profileUserId) {
      setProfileSummary(null)
      setProfileFull(null)
      return
    }
    let cancelled = false
    setProfileFull(null)
    void lookupUsers([profileUserId])
      .then(async (rows) => {
        if (cancelled) return
        const row = rows[0]
        setProfileSummary(row ? { id: row.id, username: row.username, avatar_key: row.avatar_key ?? null } : null)
        if (!row?.username) return
        // Best effort: a profile hidden by its owner's discovery setting 404s,
        // and the summary above is still worth showing.
        const full = await fetchUserProfile(row.username).catch(() => null)
        if (!cancelled) setProfileFull(full)
      })
      .catch(() => {
        if (!cancelled) setProfileSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [slot, profileUserId])

  const openProfileChannel = async () => {
    const channel = profileFull?.profile_channel
    if (!channel) return
    const joinKey = channel.invite_slug || channel.invite_code
    try {
      let chatId = channel.id
      if (joinKey) chatId = (await joinChatByInviteCode(joinKey)).chat_id
      useSessionStore.getState().setActiveChatId(chatId)
      close()
    } catch { /* leave the panel open; the button can be retried */ }
  }

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
      data-dock-open="true"
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
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      userId={profileSummary.id}
                      username={profileSummary.username}
                      avatarKey={profileSummary.avatar_key}
                      size={42}
                    />
                    <div className="min-w-0">
                      <p className={`truncate text-sm font-semibold ${isTerminal ? 'text-neon-cyan' : 'text-[var(--on-surface)]'}`}>
                        {profileFull?.display_name?.trim() || profileSummary.username}
                      </p>
                      <p className={`truncate text-xs ${isTerminal ? 'text-neon-cyan/70' : 'text-text-muted'}`}>
                        @{profileSummary.username}
                      </p>
                      {profileFull ? (
                        <p className={`truncate text-[10px] ${isTerminal ? 'text-neon-cyan/60' : 'text-text-muted'}`}>
                          {profileFull.status_text?.trim()
                            ? sanitizeText(profileFull.status_text)
                            : profileFull.online
                              ? t('profile.online')
                              : t('profile.offline')}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {profileFull?.bio?.trim() ? (
                    <div>
                      <p className={`mb-1 text-[10px] uppercase tracking-widest ${isTerminal ? 'text-neon-cyan/60' : 'text-text-muted'}`}>
                        {t('profile.bio')}
                      </p>
                      <p className={`whitespace-pre-wrap break-words text-xs ${isTerminal ? 'text-neon-cyan/80' : 'text-[var(--on-surface)]'}`}>
                        {sanitizeText(profileFull.bio)}
                      </p>
                    </div>
                  ) : null}

                  {profileFull?.profile_channel ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        {profileFull.profile_channel.avatar_key ? (
                          <ChatAvatar
                            chatId={profileFull.profile_channel.id}
                            name={profileFull.profile_channel.name}
                            avatarKey={profileFull.profile_channel.avatar_key}
                            size={20}
                          />
                        ) : (
                          <Megaphone className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate">{sanitizeText(profileFull.profile_channel.name)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void openProfileChannel()}
                        className={`shrink-0 px-2 py-1 text-[10px] uppercase tracking-widest ${isTerminal ? 'border border-neon-cyan/50 text-neon-cyan hover:bg-neon-cyan/10' : 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-[var(--on-surface)]'}`}
                      >
                        {t('profile.subscribeChannel')}
                      </button>
                    </div>
                  ) : null}

                  {profileFull?.social_links?.length ? (
                    <div className="space-y-1">
                      {profileFull.social_links.map((link, idx) => {
                        const safe = sanitizeUrl(link.url)
                        if (!safe) return null
                        return (
                          <a
                            key={idx}
                            href={safe}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`block truncate text-[11px] ${isTerminal ? 'text-neon-cyan/80 hover:text-neon-cyan' : 'text-[var(--primary)]'}`}
                          >
                            {sanitizeText(link.platform)}
                          </a>
                        )
                      })}
                    </div>
                  ) : null}

                  <p className={`truncate text-[10px] ${isTerminal ? 'text-neon-cyan/50' : 'text-text-muted'}`}>
                    ID: {profileSummary.id}
                  </p>
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
          <div className="p-2">
            <ChatEmojiPicker
              height={420}
              onPick={(emoji) => {
                emojiOnPick?.(emoji)
              }}
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

        {/* D17 — the "pinned messages" dock slot was a dead "coming soon"
            placeholder with no way to open it (dockStore.openPinned is never
            called). Pin/unpin now confirms via a toast (see message-actions),
            so the placeholder is removed rather than shipping a stub panel. */}
      </div>
    </ShellSurface>
  )
}

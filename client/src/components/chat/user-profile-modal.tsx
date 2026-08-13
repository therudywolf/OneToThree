'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Github,
  Globe,
  Megaphone,
  Send,
  MessageSquare,
  Phone,
  Video,
  ShieldX,
  ImageIcon,
  FileText,
  X,
} from 'lucide-react'
import { blockUser, fetchBlockedUsers, fetchUserProfile, unblockUser, type UserProfile } from '@/lib/api/users'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { ChatAvatar } from '@/components/chat-avatar'
import { canonicalUserId } from '@/lib/user-id'
import { useSessionStore } from '@/store/sessionStore'
import { fetchSharedMedia, type SharedMediaRow } from '@/lib/api/messages'
import { useTranslation } from '@/hooks/use-translation'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import { UserAvatar } from '@/components/user-avatar'
import { sanitizeText, sanitizeUrl } from '@/lib/sanitize'

type Props = {
  userId: string
  username: string
  avatarKey?: string | null
  onClose: () => void
  onMessage?: () => void
  onVoiceCall?: () => void
  onVideoCall?: () => void
}

const PLATFORM_ICONS: Record<string, typeof Github> = {
  github: Github,
  telegram: Send,
  website: Globe,
}

type ProfileTab = 'info' | 'media' | 'files'

export function UserProfileModal({
  userId,
  username,
  avatarKey,
  onClose,
  onMessage,
  onVoiceCall,
  onVideoCall,
}: Props) {
  const { t } = useTranslation()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<ProfileTab>('info')
  const [avatarFullscreen, setAvatarFullscreen] = useState(false)
  const [sharedMediaItems, setSharedMediaItems] = useState<SharedMediaRow[]>([])
  const [sharedFileItems, setSharedFileItems] = useState<SharedMediaRow[]>([])
  const [mediaLoading, setMediaLoading] = useState(false)
  const [filesLoading, setFilesLoading] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const [filesLoaded, setFilesLoaded] = useState(false)
  // null = the blocked-list fetch hasn't resolved (or failed) — button disabled.
  const [blocked, setBlocked] = useState<boolean | null>(null)
  const [blockArmed, setBlockArmed] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)
  const [channelBusy, setChannelBusy] = useState(false)
  const [channelErr, setChannelErr] = useState(false)

  // ESC-to-close + Tab focus trap + body scroll lock, matching every other dialog.
  // When the fullscreen avatar overlay is open, Escape dismisses that layer
  // first instead of tearing down the whole profile modal.
  const handleEscape = useCallback(() => {
    if (avatarFullscreen) {
      setAvatarFullscreen(false)
      return
    }
    onClose()
  }, [avatarFullscreen, onClose])
  const trapRef = useFocusTrap<HTMLDivElement>(true, handleEscape)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchUserProfile(username)
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [username])

  useEffect(() => {
    let cancelled = false
    void fetchBlockedUsers()
      .then((rows) => {
        if (cancelled) return
        setBlocked(rows.some((r) => canonicalUserId(r.user_id) === canonicalUserId(userId)))
      })
      .catch(() => {
        if (!cancelled) setBlocked(null)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const toggleBlock = async () => {
    if (blockBusy || blocked === null) return
    // Blocking is destructive-ish — require a second click within 3s.
    if (!blocked && !blockArmed) {
      setBlockArmed(true)
      setTimeout(() => setBlockArmed(false), 3000)
      return
    }
    setBlockBusy(true)
    try {
      if (blocked) await unblockUser(userId)
      else await blockUser(userId)
      setBlocked(!blocked)
    } catch {
      // keep the current state — the next click retries
    } finally {
      setBlockBusy(false)
      setBlockArmed(false)
    }
  }

  // Subscribe to (or just open) the profile-pinned channel. Join is idempotent
  // for existing members, so one call covers both cases.
  const openProfileChannel = async () => {
    const channel = profile?.profile_channel
    if (!channel || channelBusy) return
    const joinKey = channel.invite_slug || channel.invite_code
    setChannelBusy(true)
    setChannelErr(false)
    try {
      let chatId = channel.id
      if (joinKey) {
        const joined = await joinChatByInviteCode(joinKey)
        chatId = joined.chat_id
      }
      useSessionStore.getState().setActiveChatId(chatId)
      onClose()
    } catch {
      setChannelErr(true)
    } finally {
      setChannelBusy(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'media' && !mediaLoaded) {
      setMediaLoading(true)
      void fetchSharedMedia(userId, 'media')
        .then((rows) => {
          setSharedMediaItems(rows)
          setMediaLoaded(true)
        })
        .catch(() => setSharedMediaItems([]))
        .finally(() => setMediaLoading(false))
    }
    if (activeTab === 'files' && !filesLoaded) {
      setFilesLoading(true)
      void fetchSharedMedia(userId, 'files')
        .then((rows) => {
          setSharedFileItems(rows)
          setFilesLoaded(true)
        })
        .catch(() => setSharedFileItems([]))
        .finally(() => setFilesLoading(false))
    }
  }, [activeTab, userId, mediaLoaded, filesLoaded])

  const statusLabel = profile?.status_text
    ? profile.status_text.toUpperCase()
    : profile?.online
      ? t('profile.online')
      : t('profile.offline')
  const statusColor = profile?.online ? 'text-neon-cyan' : 'text-text-muted'
  const dotColor = profile?.online
    ? 'bg-neon-cyan animate-pulse'
    : 'bg-surface-elevated'

  const lastSeen = profile?.last_seen_at
    ? new Date(profile.last_seen_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[150] flex items-end justify-center overflow-y-auto bg-void/90 backdrop-blur-sm md:items-center"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('profile.title')} :: ${username}`}
        onPointerDown={onClose}
      >
        <motion.div
          ref={trapRef}
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 60 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="terminal-panel p13-dialog-panel relative my-auto flex w-full max-w-md flex-col overflow-hidden border border-neon-cyan/40 bg-void shadow-[0_0_30px_rgba(0,255,255,0.05)] md:max-h-[85vh] md:rounded-none"
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
        >
          {/* Close / drag handle for mobile */}
          <div className="flex items-center justify-center py-2 md:hidden">
            <div className="h-1 w-10 rounded-full bg-neon-cyan/30" />
          </div>

          {/* Close button (desktop) */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="absolute right-4 top-4 z-10 grid h-7 w-7 place-items-center rounded-full text-neon-red transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Scrollable content */}
          <div className="p13-dialog-scroll flex-1 px-6 pb-4">
            {/* Avatar */}
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={() => setAvatarFullscreen(true)}
                className="group relative"
                title={t('profile.viewFullPhoto')}
              >
                <UserAvatar
                  userId={userId}
                  username={username}
                  avatarKey={avatarKey ?? null}
                  size={128}
                />
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-void/0 transition-colors group-hover:bg-void/40">
                  <span className="hidden font-mono text-[8px] uppercase tracking-widest text-neon-cyan group-hover:block">
                    VIEW
                  </span>
                </div>
              </button>
            </div>

            {/* Display name + Username + ID */}
            <div className="mt-4 space-y-1 text-center">
              {profile?.display_name ? (
                <>
                  <p className="font-mono text-xl uppercase tracking-[0.15em] text-neon-cyan">
                    {profile.display_name}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                    @{username}
                  </p>
                </>
              ) : (
                <p className="font-mono text-xl uppercase tracking-[0.15em] text-neon-cyan">
                  {username}
                </p>
              )}
              <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                ID: {userId.split('-')[0]}
              </p>
            </div>

            {/* Status */}
            <div className="mt-4 flex items-center justify-center gap-2 border-t border-neon-cyan/20 pt-4">
              <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
              <p className={`font-mono text-[10px] uppercase tracking-wider ${statusColor}`}>
                [ {statusLabel} ]
              </p>
            </div>

            {/* Last seen */}
            {!profile?.online && lastSeen ? (
              <p className="mt-1 text-center font-mono text-[9px] text-text-muted/70">
                {t('profile.lastSeen')}: {lastSeen}
              </p>
            ) : null}

            {/* Action buttons */}
            <div className="mt-4 flex items-center justify-center gap-2">
              {onMessage ? (
                <button
                  type="button"
                  onClick={() => {
                    onMessage()
                    onClose()
                  }}
                  className="flex items-center gap-1.5 border border-neon-cyan/50 bg-void px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('profile.message')}
                </button>
              ) : null}
              {onVoiceCall ? (
                <button
                  type="button"
                  onClick={() => {
                    onVoiceCall()
                    onClose()
                  }}
                  className="flex items-center gap-1.5 border border-neon-cyan/50 bg-void px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  <Phone className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {onVideoCall ? (
                <button
                  type="button"
                  onClick={() => {
                    onVideoCall()
                    onClose()
                  }}
                  className="flex items-center gap-1.5 border border-neon-cyan/50 bg-void px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  <Video className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                disabled={blockBusy || blocked === null}
                onClick={() => void toggleBlock()}
                className="flex items-center gap-1.5 border border-danger/40 bg-void px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-danger transition-colors hover:border-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                title={blocked ? t('profile.unblock') : t('profile.block')}
              >
                <ShieldX className="h-3.5 w-3.5" />
                {blocked ? t('profile.unblock') : blockArmed ? t('profile.blockConfirm') : t('profile.block')}
              </button>
            </div>

            {/* Tabs: Info / Media / Files */}
            <div className="mt-4 flex border-b border-neon-cyan/20">
              {(['info', 'media', 'files'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors ${
                    activeTab === tab
                      ? 'border-b-2 border-neon-cyan text-neon-cyan'
                      : 'text-text-muted/70 hover:text-text-muted'
                  }`}
                >
                  {tab === 'info'
                    ? t('profile.bio')
                    : tab === 'media'
                      ? t('profile.sharedMedia')
                      : t('profile.sharedFiles')}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="mt-3 min-h-[8rem]">
              {activeTab === 'info' ? (
                <div className="space-y-4">
                  {/* Bio */}
                  {profile?.bio ? (
                    <div>
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/60">
                        {t('profile.bio')}
                      </p>
                      <p className="font-mono text-[11px] text-neon-cyan/80 whitespace-pre-wrap break-words leading-relaxed">
                        {sanitizeText(profile.bio)}
                      </p>
                    </div>
                  ) : null}

                  {/* Social Links */}
                  {profile?.social_links && profile.social_links.length > 0 ? (
                    <div className="space-y-2">
                      <p className="font-mono text-[9px] uppercase tracking-widest text-neon-cyan/60">
                        {t('profile.externalLinks')}
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {profile.social_links.map((link, idx) => {
                          const Icon =
                            PLATFORM_ICONS[link.platform.toLowerCase()] ?? Globe
                          const safeUrl = sanitizeUrl(link.url)
                          if (!safeUrl) return null
                          return (
                            <a
                              key={idx}
                              href={safeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-between border border-neon-cyan/30 bg-void/50 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-neon-cyan hover:border-neon-cyan hover:bg-neon-cyan/10 transition-all"
                            >
                              <span className="flex items-center gap-2">
                                <Icon className="h-3 w-3" />
                                {sanitizeText(link.platform)}
                              </span>
                              <span className="text-neon-red">&#8599;</span>
                            </a>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Profile-pinned channel («стена») */}
                  {profile?.profile_channel ? (
                    <div className="space-y-2">
                      <p className="font-mono text-[9px] uppercase tracking-widest text-neon-cyan/60">
                        {t('explore.typeChannel')}
                      </p>
                      <div className="flex items-center justify-between gap-2 border border-neon-cyan/30 bg-void/50 px-3 py-2">
                        <span className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-neon-cyan/80">
                          {profile.profile_channel.avatar_key ? (
                            <ChatAvatar
                              chatId={profile.profile_channel.id}
                              name={profile.profile_channel.name}
                              avatarKey={profile.profile_channel.avatar_key}
                              size={20}
                            />
                          ) : (
                            <Megaphone className="h-3.5 w-3.5 shrink-0" />
                          )}
                          <span className="truncate">
                            {sanitizeText(profile.profile_channel.name) || profile.profile_channel.id.slice(0, 8)}
                          </span>
                          <span className="shrink-0 text-text-muted/70">
                            · {profile.profile_channel.member_count} {t('profile.subscribers')}
                          </span>
                        </span>
                        <button
                          type="button"
                          disabled={channelBusy}
                          onClick={() => void openProfileChannel()}
                          className="shrink-0 border border-neon-cyan/50 bg-void px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-40"
                        >
                          {t('profile.subscribeChannel')}
                        </button>
                      </div>
                      {channelErr ? (
                        <p className="font-mono text-[9px] text-danger">{t('profile.joinFailed')}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Mutual groups */}
                  <div>
                    <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/60">
                      {t('profile.mutualGroups')}
                    </p>
                    {profile?.mutual_groups && profile.mutual_groups.length > 0 ? (
                      <div className="space-y-1">
                        {profile.mutual_groups.map((g) => (
                          <div
                            key={g.id}
                            className="flex items-center gap-2 border border-neon-cyan/20 bg-void/50 px-3 py-2 font-mono text-[10px] text-neon-cyan/80"
                          >
                            <span className="h-2 w-2 rounded-full bg-neon-cyan/40 shrink-0" />
                            <span className="truncate">{sanitizeText(g.name) || g.id.slice(0, 8)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="font-mono text-[10px] text-text-muted/70">
                        {t('profile.noMutualGroups')}
                      </p>
                    )}
                  </div>
                </div>
              ) : activeTab === 'media' ? (
                <div className="space-y-3">
                  {mediaLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <p className="animate-pulse font-mono text-[10px] text-neon-cyan/60">
                        [ LOADING... ]
                      </p>
                    </div>
                  ) : sharedMediaItems.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1">
                      {sharedMediaItems.map((item) => (
                        <div
                          key={item.id}
                          className="relative aspect-square border border-neon-cyan/20 bg-void overflow-hidden"
                        >
                          <div className="flex h-full w-full items-center justify-center">
                            <div className="text-center">
                              {item.media_type === 'video' ? (
                                <span className="font-mono text-[8px] uppercase text-neon-cyan/50">VIDEO</span>
                              ) : (
                                <ImageIcon className="mx-auto h-5 w-5 text-neon-cyan/30" />
                              )}
                            </div>
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-void/80 px-1 py-0.5">
                            <p className="font-mono text-[7px] text-text-muted truncate">
                              {new Date(item.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-8">
                      <div className="text-center">
                        <ImageIcon className="mx-auto h-8 w-8 text-text-muted/70" />
                        <p className="mt-2 font-mono text-[10px] text-text-muted/70">
                          {t('group.mediaArchiveEmpty')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {filesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <p className="animate-pulse font-mono text-[10px] text-neon-cyan/60">
                        [ LOADING... ]
                      </p>
                    </div>
                  ) : sharedFileItems.length > 0 ? (
                    <div className="space-y-1">
                      {sharedFileItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center gap-2 border border-neon-cyan/20 bg-void/50 px-3 py-2"
                        >
                          <FileText className="h-4 w-4 text-neon-cyan/40 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-[10px] text-neon-cyan/80 truncate">
                              {item.media_path?.split('/').pop() ?? 'file'}
                            </p>
                            <p className="font-mono text-[8px] text-text-muted/70">
                              {new Date(item.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-8">
                      <div className="text-center">
                        <FileText className="mx-auto h-8 w-8 text-text-muted/70" />
                        <p className="mt-2 font-mono text-[10px] text-text-muted/70">
                          {t('group.mediaArchiveEmpty')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Loading indicator */}
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-void/80">
              <p className="animate-pulse font-mono text-[10px] text-neon-cyan/60">
                [ LOADING... ]
              </p>
            </div>
          ) : null}

          {/* Footer hint */}
          <div
            className="shrink-0 border-t border-neon-cyan/20 px-6 pt-2 text-center md:pb-2"
            style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0.5rem))' }}
          >
            <p className="font-mono text-[8px] text-text-muted/70 uppercase tracking-widest">
              [ {t('profile.tapToClose')} ]
            </p>
          </div>
        </motion.div>
      </motion.div>

      {/* Avatar fullscreen view */}
      {avatarFullscreen ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-void/95"
          onClick={() => setAvatarFullscreen(false)}
        >
          <UserAvatar
            userId={userId}
            username={username}
            avatarKey={avatarKey ?? null}
            size={280}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

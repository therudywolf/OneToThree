'use client'

import { useState, useEffect } from 'react'
import { Pin, ShieldCheck, Search, Loader2, MessageSquarePlus, Star, ShieldAlert } from 'lucide-react'
import Link from 'next/link'
import { useChatStore } from '@/store/chatStore'
import { createDirectE2EChat, leaveChat, deleteChat, fetchOrCreateSelfChat, setChatFavorite } from '@/lib/api/chats'
import { useChats } from '@/hooks/use-chats'
import { CreateGroupModal } from '@/components/chat/create-group-modal'
import { GroupChatSettings } from '@/components/chat/group-chat-settings'
import { UserAvatar } from '@/components/user-avatar'
import { lookupUsers, searchUsers } from '@/lib/api/users'
import { useTranslation } from '@/hooks/use-translation'
import { ChatRowSkeleton } from '@/components/ui/skeleton'
import { hashPublicKeyJwk } from '@/lib/crypto'
import { resolveTrustStatus } from '@/lib/trust-store'
import { isUuid, normalizePeerInput } from '@/lib/peer-input'
import { canonicalUserId } from '@/lib/user-id'
import type { ApiChatRow } from '@/lib/api/chats'
import { searchLocalMessages } from '@/lib/message-cache'

const PINNED_CHATS_KEY = 'fm_pinned_chats'

function loadPinnedIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(PINNED_CHATS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function chatActivityTs(c: ApiChatRow): number {
  const t = c.last_message_at
  if (!t) return 0
  const n = new Date(t).getTime()
  return Number.isFinite(n) ? n : 0
}

function sortChatsByLatest(a: ApiChatRow, b: ApiChatRow): number {
  return chatActivityTs(b) - chatActivityTs(a)
}

function orderedSidebarChats(
  chats: ApiChatRow[],
  pinnedOrder: string[]
): ApiChatRow[] {
  const pinnedSet = new Set(pinnedOrder)
  const favorites = chats.filter((c) => c.is_favorite).sort(sortChatsByLatest)
  const pinned = chats
    .filter((c) => !c.is_favorite && pinnedSet.has(c.id))
    .sort(sortChatsByLatest)
  const unpinned = chats
    .filter((c) => !c.is_favorite && !pinnedSet.has(c.id))
    .sort(sortChatsByLatest)
  return [...favorites, ...pinned, ...unpinned]
}

type ChatSidebarProps = {
  userId: string
  /** Backward-compat for older callers; sidebar no longer needs it directly. */
  username?: string
  isAdmin?: boolean
  sharedKey: CryptoKey | null
  onPackSettingsChanged?: () => void
  onNavigate?: () => void
}

export function ChatSidebar({
  userId,
  isAdmin,
  sharedKey,
  onPackSettingsChanged,
  onNavigate,
}: ChatSidebarProps) {
  const { t } = useTranslation()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const peerPresence = useChatStore((s) => s.peerPresence)
  const unreadByChat = useChatStore((s) => s.unreadByChat)
  const { chats, reload, initialLoading } = useChats(userId)
  const [peerInput, setPeerInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trustedPeerIds, setTrustedPeerIds] = useState<Set<string>>(new Set())
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinnedIds)
  const [localGhostQuery, setLocalGhostQuery] = useState('')
  const [ghostHitChatIds, setGhostHitChatIds] = useState<Set<string> | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [peerLookupByUserId, setPeerLookupByUserId] = useState<
    Record<string, { username: string; avatar_key: string | null }>
  >({})

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify(pinnedIds))
    } catch {
      /* ignore quota */
    }
  }, [pinnedIds])

  useEffect(() => {
    const peerIds = Array.from(
      new Set(
        chats
          .filter((c) => !c.is_group)
          .map((c) => c.member_ids.find((id) => id !== userId))
          .filter((id): id is string => Boolean(id))
      )
    )
    if (!peerIds.length) {
      setPeerLookupByUserId({})
      return
    }
    let cancelled = false
    void lookupUsers(peerIds)
      .then((rows) => {
        if (cancelled) return
        const next: Record<string, { username: string; avatar_key: string | null }> = {}
        for (const r of rows) {
          next[r.id] = {
            username: r.username,
            avatar_key: r.avatar_key ?? null,
          }
        }
        setPeerLookupByUserId(next)
      })
      .catch(() => {
        if (!cancelled) setPeerLookupByUserId({})
      })
    return () => {
      cancelled = true
    }
  }, [chats, userId])

  const sidebarChats = orderedSidebarChats(chats, pinnedIds)

  useEffect(() => {
    const q = localGhostQuery.trim()
    if (q.length < 2) {
      setGhostHitChatIds(null)
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    let cancelled = false
    const tm = window.setTimeout(() => {
      void searchLocalMessages(q).then((rows) => {
        if (cancelled) return
        setGhostHitChatIds(new Set(rows.map((r) => r.chatId)))
        setIsSearching(false)
      })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(tm)
    }
  }, [localGhostQuery])

  const nonSelfChats = sidebarChats.filter(
    (c) => !(
      !c.is_group &&
      c.member_ids.length === 1 &&
      c.member_ids[0] === userId
    )
  )

  const sidebarChatsFiltered =
    ghostHitChatIds === null
      ? nonSelfChats
      : nonSelfChats.filter((c) => ghostHitChatIds.has(c.id))

  function togglePin(chatId: string) {
    setPinnedIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId]
    )
  }

  async function toggleFavorite(chatId: string, current: boolean) {
    try {
      await setChatFavorite(chatId, !current)
      await reload()
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'ERR')
    }
  }

  function mapSidebarError(code: string): string {
    const m: Record<string, string> = {
      USER_NOT_FOUND_OR_HIDDEN: t('sidebar.userNotFound'),
      CANNOT_OPEN_DIRECT_WITH_SELF: t('sidebar.cannotOpenSelf'),
      CREATE_FAILED: t('sidebar.createFailed'),
      INVITE_LINK_COPIED: t('sidebar.copyInviteSuccess'),
    }
    return m[code] ?? code
  }

  async function openDirect() {
    const raw = normalizePeerInput(peerInput)
    if (!raw) return
    setCreating(true)
    setCreateErr(null)
    try {
      let pid = raw
      if (!isUuid(raw)) {
        const candidates = await searchUsers(raw)
        const lower = raw.toLowerCase()
        const exact = candidates.find(
          (u) => u.username.toLowerCase() === lower
        )
        const picked =
          exact ??
          (candidates.length === 1 ? candidates[0] : undefined)
        if (!picked) {
          throw new Error('USER_NOT_FOUND_OR_HIDDEN')
        }
        pid = picked.id
      }
      if (canonicalUserId(pid) === canonicalUserId(userId)) {
        throw new Error('CANNOT_OPEN_DIRECT_WITH_SELF')
      }
      const chat = await createDirectE2EChat(userId, pid)
      setActiveChatId(chat.id)
      setPeerInput('')
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'CREATE_FAILED')
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    const directPeerIds = chats
      .filter((c) => !c.is_group)
      .map((c) => c.member_ids.find((id) => id !== userId))
      .filter((id): id is string => Boolean(id))
    if (!directPeerIds.length) {
      setTrustedPeerIds(new Set())
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const users = await lookupUsers(directPeerIds)
        const trusted = new Set<string>()
        for (const u of users) {
          if (!u.ecdh_public_key_jwk) continue
          try {
            const jwk = JSON.parse(u.ecdh_public_key_jwk) as JsonWebKey
            const hash = await hashPublicKeyJwk(jwk)
            const trust = resolveTrustStatus(u.id, hash)
            if (trust.verified) trusted.add(u.id)
          } catch {
            /* ignore parse failures */
          }
        }
        if (!cancelled) setTrustedPeerIds(trusted)
      } catch {
        if (!cancelled) setTrustedPeerIds(new Set())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chats, userId])

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-neon-cyan/30 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_92%,transparent),color-mix(in_srgb,var(--void)_84%,transparent))] backdrop-blur-xl md:w-[21.5rem] md:shrink-0 shadow-[8px_0_40px_rgba(0,0,0,0.32),1px_0_0_rgba(255,255,255,0.02)]">
      {groupModalOpen ? (
        <CreateGroupModal
          userId={userId}
          onClose={() => setGroupModalOpen(false)}
          onCreated={(id) => {
            setActiveChatId(id)
            setGroupModalOpen(false)
            onNavigate?.()
          }}
        />
      ) : null}

      {/* Header */}
      <div className="border-b border-neon-cyan/25 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface)_96%,transparent),color-mix(in_srgb,var(--surface-elevated)_88%,transparent))] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-[0.32em] text-neon-cyan">
              {t('sidebar.channels')}
            </span>
            <p className="text-[10px] leading-relaxed text-text-muted">
              Favorites, direct routes and encrypted groups live here.
            </p>
          </div>
          <span className="mt-1 flex h-2.5 w-2.5 rounded-full bg-neon-cyan animate-pulse shadow-[0_0_10px_rgba(0,255,255,0.85)]" />
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-neon-cyan/15 bg-void/25 px-4 py-3">
        <label className="sr-only" htmlFor="ghost-search">
          {t('sidebar.localGhostSearch')}
        </label>
        <div className="relative flex items-center overflow-hidden rounded-2xl border border-border-strong/5 bg-surface/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {isSearching ? (
            <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin text-neon-cyan/50" />
          ) : (
            <Search className="absolute left-3 h-3.5 w-3.5 text-neon-cyan/50" />
          )}
          <input
            id="ghost-search"
            className="w-full bg-transparent px-3 py-2 pl-9 text-[11px] text-neon-cyan placeholder:text-neon-cyan/30 focus:outline-none"
            placeholder={t('sidebar.localGhostSearch')}
            value={localGhostQuery}
            onChange={(e) => setLocalGhostQuery(e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
      </div>

      {/* Saved Messages — Telegram-style self-chat.
       *
       * The server exposes /api/chats/self which is idempotent: it returns the
       * existing self-chat or creates one on the fly.  We used to silently
       * swallow errors here, which made the button look dead whenever the
       * network blinked or the session lost auth.  Now:
       *   1. If we already have it in the local list, open it instantly
       *      (avoids a needless roundtrip and the reload-race below).
       *   2. Otherwise hit the API, and surface failures to the operator so
       *      the button is never silent-broken.
       */}
      <button
        type="button"
        onClick={async () => {
          const existingSelf = chats.find(
            (c) =>
              !c.is_group &&
              c.member_ids.length === 1 &&
              c.member_ids[0] === userId
          )
          if (existingSelf) {
            setActiveChatId(existingSelf.id)
            onNavigate?.()
            return
          }
          try {
            const self = await fetchOrCreateSelfChat()
            setActiveChatId(self.id)
            onNavigate?.()
            void reload()
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[saved-messages] open failed', err)
            // Re-throw so React error boundary can surface it; swallowing made
            // the button look dead in the wild.
          }
        }}
        className="mx-3 mt-3 flex items-center gap-2 rounded-2xl border border-accent-2/40 bg-[linear-gradient(180deg,rgba(255,191,0,0.08),rgba(255,191,0,0.03))] px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest text-neon-cyan/80 transition-colors hover:border-accent-2/40 hover:bg-accent-2/15 hover:text-neon-cyan"
      >
        <Star className="h-3.5 w-3.5 text-accent-2 fill-accent-2" />
        {t('sidebar.savedMessages')}
      </button>

      {/* Chat List */}
      <nav className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain px-3 pb-3 pt-3 [-webkit-overflow-scrolling:touch]">
        {initialLoading ? (
          <div className="space-y-2 py-1">
            {Array.from({ length: 5 }, (_, i) => (
              <ChatRowSkeleton key={i} />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className="px-4 py-8 text-center space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted/70">
              {t('sidebar.noActiveRoutes')}
            </p>
            <p className="text-[9px] text-text-muted/70">
              {t('chat.startChatHint')}
            </p>
            <button
              type="button"
              onClick={() => setGroupModalOpen(true)}
              className="inline-flex items-center gap-1.5 border border-neon-cyan/50 bg-void px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            >
              <MessageSquarePlus className="h-3 w-3" />
              {t('chat.newChat')}
            </button>
          </div>
        ) : null}

        {ghostHitChatIds !== null &&
        localGhostQuery.trim().length >= 2 &&
        sidebarChatsFiltered.length === 0 ? (
            <p className="mx-1 mt-2 rounded-2xl border border-neon-red/30 bg-danger/30 px-4 py-6 text-center font-mono text-[10px] uppercase tracking-widest text-neon-red">
              {t('sidebar.ghostNoHits')}
            </p>
        ) : null}

        {sidebarChatsFiltered.map((c) => {
          const isPinned = pinnedIds.includes(c.id)
          const unread = unreadByChat[c.id]
          const unreadTotal = unread?.total ?? 0
          const mentionTotal = unread?.mentions ?? 0
          const threadTotal = unread ? Object.values(unread.threads).reduce((acc, v) => acc + v, 0) : 0
          const peerId = !c.is_group
            ? c.member_ids.find((id) => id !== userId)
            : null
          const pres = peerId ? peerPresence[peerId] : undefined
          const resolved = peerId ? peerLookupByUserId[peerId] : undefined
          const peerName =
            c.name?.trim() ||
            resolved?.username?.trim() ||
            (peerId ? `${peerId.slice(0, 8)}…` : '')
          const listTitle = c.is_group
            ? c.name?.trim() || t('sidebar.groupUntitled')
            : c.name?.trim() ||
              resolved?.username?.trim() ||
              (peerId ? `${peerId.slice(0, 8)}…` : `${c.id.slice(0, 8)}…`)

          return (
            <div
              key={c.id}
              className={`group mb-2 flex w-full items-stretch overflow-hidden rounded-2xl border transition-all ${
                activeChatId === c.id
                  ? 'border-neon-cyan/35 bg-[linear-gradient(180deg,rgba(0,255,255,0.12),rgba(0,255,255,0.04))] shadow-[0_12px_28px_rgba(0,255,255,0.08)]'
                  : 'border-border-strong/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] hover:border-neon-cyan/20 hover:bg-neon-cyan/[0.06]'
              } ${isPinned ? 'ring-1 ring-inset ring-neon-cyan/20' : ''}`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 px-3 py-3 text-left font-mono text-xs outline-none"
                aria-label={`${t('common.openChatAria')} ${listTitle}`}
                onClick={() => {
                  setActiveChatId(c.id)
                  onNavigate?.()
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-3">
                  <div className="relative">
                    {peerId ? (
                      <UserAvatar
                        userId={peerId}
                        username={peerName || '…'}
                        avatarKey={resolved?.avatar_key ?? null}
                        size={28}
                      />
                    ) : c.is_group ? (
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-neon-cyan/50 bg-void font-mono text-[10px] text-neon-cyan">
                        GRP
                      </div>
                    ) : null}

                    {!c.is_group && pres?.online ? (
                       <span className="absolute -bottom-0.5 -right-0.5 block h-2.5 w-2.5 rounded-full border-2 border-border-strong bg-neon-cyan/15 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                    ) : null}
                  </div>

                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="inline-flex items-center gap-1.5">
                      {!c.is_group && trustedPeerIds.has(peerId ?? '') ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-neon-cyan shrink-0" />
                      ) : null}
                      <span className={`truncate text-[12px] ${activeChatId === c.id ? 'font-semibold text-neon-cyan' : 'text-neon-cyan/85'}`}>
                        {listTitle}
                      </span>
                      {isPinned ? (
                        <span className="rounded-full border border-neon-cyan/25 bg-neon-cyan/10 px-1.5 py-0.5 text-[8px] uppercase tracking-[0.24em] text-neon-cyan/80">
                          Pin
                        </span>
                      ) : null}
                    </span>

                    {pres && !pres.online ? (
                      <span className="truncate text-[10px] text-text-muted">
                        {t('sidebar.lastSeen')}:{' '}
                        {pres.last_seen_at
                          ? new Date(pres.last_seen_at).toLocaleString(
                              undefined,
                              { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
                            )
                          : '—'}
                      </span>
                    ) : c.is_group ? (
                      <span className="truncate text-[10px] text-text-muted">
                         {c.member_ids.length} {t('sidebar.members')}
                       </span>
                    ) : null}
                  </span>
                  {unreadTotal > 0 ? (
                    <span className="ml-auto inline-flex items-center gap-1 self-center">
                      {threadTotal > 0 ? (
                        <span className="rounded border border-neon-cyan/50 bg-neon-cyan/10 px-1 py-[1px] text-[8px] font-bold text-neon-cyan">
                          T{threadTotal}
                        </span>
                      ) : null}
                      {mentionTotal > 0 ? (
                        <span className="rounded border border-accent-2/40 bg-accent-2/15 px-1 py-[1px] text-[8px] font-bold text-accent-2">
                          @{mentionTotal}
                        </span>
                      ) : null}
                      <span className="rounded border border-neon-cyan/60 bg-void px-1.5 py-[1px] text-[9px] font-bold text-neon-cyan">
                        {unreadTotal > 99 ? '99+' : unreadTotal}
                      </span>
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                title={isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
                onClick={(e) => {
                  e.stopPropagation()
                  togglePin(c.id)
                }}
                className={`shrink-0 border-l border-border-strong/5 px-3 transition-colors ${
                  isPinned
                    ? 'bg-neon-cyan/5 text-neon-cyan hover:bg-neon-red/10 hover:text-neon-red'
                    : 'text-text-muted/70 opacity-0 hover:bg-neon-cyan/10 hover:text-neon-cyan group-hover:opacity-100'
                }`}
              >
                <Pin className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                title={c.is_favorite ? t('sidebar.unfavorite') : t('sidebar.favorite')}
                onClick={(e) => {
                  e.stopPropagation()
                  void toggleFavorite(c.id, Boolean(c.is_favorite))
                }}
                className={`shrink-0 border-l border-border-strong/5 px-3 transition-colors ${
                  c.is_favorite
                    ? 'text-accent-2 bg-accent-2/15 hover:bg-accent-2/15'
                    : 'text-text-muted/70 hover:bg-accent-2/15 hover:text-accent-2 opacity-0 group-hover:opacity-100'
                }`}
              >
                <Star className={`h-3.5 w-3.5 ${c.is_favorite ? 'fill-accent-2' : ''}`} aria-hidden />
              </button>
            </div>
          )
        })}
      </nav>

      {/* Active Chat Controls */}
      {activeChatId ? (
        <div className="border-t border-neon-cyan/20 bg-void/20 p-3 space-y-2">
          {chats.find((c) => c.id === activeChatId)?.is_group ? (
            <GroupChatSettings
              chatId={activeChatId}
              userId={userId}
              sharedKey={sharedKey}
              onChanged={() => {
                void reload()
                onPackSettingsChanged?.()
              }}
            />
          ) : null}

          <div className="flex gap-1">
            {chats.find((c) => c.id === activeChatId)?.is_group ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void leaveChat(activeChatId)
                    .then(() => {
                      setActiveChatId(null)
                      void reload()
                    })
                    .catch((e) => setCreateErr(e instanceof Error ? e.message : 'ERR'))
                    .finally(() => setBusy(false))
                }}
                className="flex-1 border border-danger/40 bg-void py-1.5 font-mono text-[9px] uppercase tracking-widest text-danger transition-colors hover:border-neon-red hover:bg-neon-red/10 disabled:opacity-40"
              >
                {t('sidebar.leaveGroup')}
              </button>
            ) : null}

            {(() => {
              const row = chats.find((c) => c.id === activeChatId)
              const showDelete = !row?.is_group || row.my_role === 'owner'
              if (!showDelete) return null
              return (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(t('sidebar.purgeChatConfirm'))) return
                    setBusy(true)
                    void deleteChat(activeChatId)
                      .then(() => {
                        setActiveChatId(null)
                        void reload()
                      })
                      .catch((e) => setCreateErr(e instanceof Error ? e.message : 'ERR'))
                      .finally(() => setBusy(false))
                  }}
                  className="flex-1 border border-danger/40 bg-void py-1.5 font-mono text-[9px] uppercase tracking-widest text-danger transition-colors hover:border-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                >
                  {t('sidebar.deleteChat')}
                </button>
              )
            })()}
          </div>
        </div>
      ) : null}

      {/* Global Actions */}
      <div className="border-t border-neon-cyan/20 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_55%,transparent),color-mix(in_srgb,var(--void)_94%,transparent))] p-3 space-y-3">

        {/* Admin link — only for admins, mobile-first placement */}
        {isAdmin ? (
          <Link
            href="/admin"
            className="flex items-center gap-2 w-full border border-danger/40 bg-void px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-danger transition-colors hover:border-neon-red hover:bg-neon-red/10 hover:text-neon-red"
          >
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>[ WARDEN ]</span>
          </Link>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              const origin = window.location.origin
              const link = `${origin}/?invite=${encodeURIComponent(userId)}`
              try {
                await navigator.clipboard.writeText(link)
                setCreateErr('INVITE_LINK_COPIED')
              } catch {
                setCreateErr(link)
              }
            }}
            className="flex-1 border border-neon-cyan/50 bg-void py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
          >
            {t('sidebar.copyMyInvite')}
          </button>
          <button
            type="button"
            onClick={() => setGroupModalOpen(true)}
            className="flex-1 border border-neon-cyan/50 bg-void py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
          >
            {t('sidebar.createGroupE2e')}
          </button>
        </div>

        <div className="pt-2 border-t border-neon-cyan/20">
          <p className="mb-1.5 text-[9px] uppercase tracking-[0.2em] text-neon-cyan/70">
            {t('sidebar.openDirect')}
          </p>

          {createErr ? (
            <p className={`mb-2 font-mono text-[9px] uppercase tracking-wider p-1 border ${createErr === 'INVITE_LINK_COPIED' ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10' : 'border-neon-red text-neon-red bg-neon-red/10'}`}>
              {mapSidebarError(createErr)}
            </p>
          ) : null}

          <div className="flex gap-1">
            <input
              className="terminal-input w-full px-2 py-1 text-[10px] placeholder:text-neon-cyan/30"
              placeholder={t('sidebar.peerPlaceholder')}
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value)}
              spellCheck="false"
            />
            <button
              type="button"
              onClick={() => void openDirect()}
              disabled={creating || !peerInput.trim()}
              className="shrink-0 border border-neon-cyan bg-void px-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-text-primary disabled:opacity-40 disabled:hover:bg-void disabled:hover:text-neon-cyan"
            >
              {t('sidebar.openPeer')}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

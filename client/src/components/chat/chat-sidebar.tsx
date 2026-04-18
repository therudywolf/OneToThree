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
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-neon-cyan/40 bg-black md:w-72 md:shrink-0 shadow-[4px_0_24px_rgba(0,255,255,0.03)]">
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
      <div className="border-b border-neon-cyan/40 bg-zinc-950/50 p-3 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan font-bold">
          {t('sidebar.channels')}
        </span>
        <span className="flex h-2 w-2 rounded-full bg-neon-cyan animate-pulse shadow-[0_0_8px_rgba(0,255,255,0.8)]" />
      </div>

      {/* Search */}
      <div className="border-b border-neon-cyan/25 bg-black px-3 py-2">
        <label className="sr-only" htmlFor="ghost-search">
          {t('sidebar.localGhostSearch')}
        </label>
        <div className="relative flex items-center">
          {isSearching ? (
            <Loader2 className="absolute left-2 h-3.5 w-3.5 text-neon-cyan/50 animate-spin" />
          ) : (
            <Search className="absolute left-2 h-3.5 w-3.5 text-neon-cyan/50" />
          )}
          <input
            id="ghost-search"
            className="w-full bg-transparent border-b border-neon-cyan/30 py-1 pl-7 text-[10px] text-neon-cyan placeholder:text-neon-cyan/30 focus:border-neon-cyan focus:outline-none transition-colors"
            placeholder={t('sidebar.localGhostSearch')}
            value={localGhostQuery}
            onChange={(e) => setLocalGhostQuery(e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
      </div>

      {/* Saved Messages */}
      <button
        type="button"
        onClick={async () => {
          try {
            const self = await fetchOrCreateSelfChat()
            setActiveChatId(self.id)
            onNavigate?.()
            void reload()
          } catch {
            /* ignore */
          }
        }}
        className="flex items-center gap-2 border-b border-neon-cyan/20 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-neon-cyan/80 transition-colors hover:bg-neon-cyan/5 hover:text-neon-cyan"
      >
        <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
        {t('sidebar.savedMessages')}
      </button>

      {/* Chat List */}
      <nav className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
        {initialLoading ? (
          <div className="space-y-1 py-2">
            {Array.from({ length: 5 }, (_, i) => (
              <ChatRowSkeleton key={i} />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className="px-4 py-8 text-center space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              {t('sidebar.noActiveRoutes')}
            </p>
            <p className="text-[9px] text-zinc-700">
              {t('chat.startChatHint')}
            </p>
            <button
              type="button"
              onClick={() => setGroupModalOpen(true)}
              className="inline-flex items-center gap-1.5 border border-neon-cyan/50 bg-black px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            >
              <MessageSquarePlus className="h-3 w-3" />
              {t('chat.newChat')}
            </button>
          </div>
        ) : null}

        {ghostHitChatIds !== null &&
        localGhostQuery.trim().length >= 2 &&
        sidebarChatsFiltered.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-[10px] uppercase tracking-widest text-neon-red border border-neon-red/30 mx-2 mt-2 bg-red-950/20">
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
              className={`group flex w-full items-stretch border-b border-neon-cyan/20 transition-colors ${
                activeChatId === c.id ? 'bg-neon-cyan/10' : 'bg-black hover:bg-neon-cyan/5'
              } ${isPinned ? 'border-l-2 border-l-neon-cyan' : 'border-l-2 border-l-transparent'}`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 px-3 py-2 text-left font-mono text-xs outline-none"
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
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-neon-cyan/50 bg-black font-mono text-[10px] text-neon-cyan">
                        GRP
                      </div>
                    ) : null}

                    {!c.is_group && pres?.online ? (
                       <span className="absolute -bottom-0.5 -right-0.5 block h-2.5 w-2.5 rounded-full border-2 border-black bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                    ) : null}
                  </div>

                  <span className="flex min-w-0 flex-col gap-[1px]">
                    <span className="inline-flex items-center gap-1.5">
                      {!c.is_group && trustedPeerIds.has(peerId ?? '') ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-neon-cyan shrink-0" />
                      ) : null}
                      <span className={`truncate ${activeChatId === c.id ? 'text-neon-cyan font-bold' : 'text-neon-cyan/80'}`}>
                        {listTitle}
                      </span>
                    </span>

                    {pres && !pres.online ? (
                      <span className="text-[9px] text-zinc-600 truncate">
                        {t('sidebar.lastSeen')}:{' '}
                        {pres.last_seen_at
                          ? new Date(pres.last_seen_at).toLocaleString(
                              undefined,
                              { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
                            )
                          : '—'}
                      </span>
                    ) : c.is_group ? (
                       <span className="text-[9px] text-zinc-600 truncate">
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
                        <span className="rounded border border-amber-400/50 bg-amber-400/10 px-1 py-[1px] text-[8px] font-bold text-amber-300">
                          @{mentionTotal}
                        </span>
                      ) : null}
                      <span className="rounded border border-neon-cyan/60 bg-black px-1.5 py-[1px] text-[9px] font-bold text-neon-cyan">
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
                className={`shrink-0 border-l border-neon-cyan/10 px-3 transition-colors ${
                  isPinned
                    ? 'text-neon-cyan bg-neon-cyan/5 hover:bg-neon-red/10 hover:text-neon-red'
                    : 'text-zinc-700 hover:bg-neon-cyan/10 hover:text-neon-cyan opacity-0 group-hover:opacity-100'
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
                className={`shrink-0 border-l border-neon-cyan/10 px-3 transition-colors ${
                  c.is_favorite
                    ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20'
                    : 'text-zinc-700 hover:bg-amber-400/10 hover:text-amber-300 opacity-0 group-hover:opacity-100'
                }`}
              >
                <Star className={`h-3.5 w-3.5 ${c.is_favorite ? 'fill-amber-400' : ''}`} aria-hidden />
              </button>
            </div>
          )
        })}
      </nav>

      {/* Active Chat Controls */}
      {activeChatId ? (
        <div className="border-t border-neon-cyan/40 bg-zinc-950/30 p-2 space-y-1">
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
                className="flex-1 border border-red-900/50 bg-black py-1.5 font-mono text-[9px] uppercase tracking-widest text-red-800 transition-colors hover:border-neon-red hover:bg-neon-red/10 disabled:opacity-40"
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
                  className="flex-1 border border-red-900/50 bg-black py-1.5 font-mono text-[9px] uppercase tracking-widest text-red-800 transition-colors hover:border-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                >
                  {t('sidebar.deleteChat')}
                </button>
              )
            })()}
          </div>
        </div>
      ) : null}

      {/* Global Actions */}
      <div className="border-t border-neon-cyan/40 bg-black p-3 space-y-2">

        {/* Admin link — only for admins, mobile-first placement */}
        {isAdmin ? (
          <Link
            href="/admin"
            className="flex items-center gap-2 w-full border border-red-900/60 bg-black px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-red-800 transition-colors hover:border-neon-red hover:bg-neon-red/10 hover:text-neon-red"
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
            className="flex-1 border border-neon-cyan/50 bg-black py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
          >
            {t('sidebar.copyMyInvite')}
          </button>
          <button
            type="button"
            onClick={() => setGroupModalOpen(true)}
            className="flex-1 border border-neon-cyan/50 bg-black py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
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
              className="shrink-0 border border-neon-cyan bg-black px-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-black disabled:opacity-40 disabled:hover:bg-black disabled:hover:text-neon-cyan"
            >
              {t('sidebar.openPeer')}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

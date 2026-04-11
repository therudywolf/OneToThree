'use client'

import { useState } from 'react'
import { useEffect } from 'react'
import { Pin, ShieldCheck } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { createDirectE2EChat, leaveChat, deleteChat } from '@/lib/api/chats'
import { useChats } from '@/hooks/use-chats'
import { CreateGroupModal } from '@/components/chat/create-group-modal'
import { GroupChatSettings } from '@/components/chat/group-chat-settings'
import { UserAvatar } from '@/components/user-avatar'
import { lookupUsers, searchUsers } from '@/lib/api/users'
import { useTranslation } from '@/hooks/use-translation'
import { hashPublicKeyJwk } from '@/lib/crypto'
import { resolveTrustStatus } from '@/lib/trust-store'
import { isUuid, normalizePeerInput } from '@/lib/peer-input'
import { canonicalUserId } from '@/lib/user-id'
import type { ApiChatRow } from '@/lib/api/chats'

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
  const pinned = chats.filter((c) => pinnedSet.has(c.id)).sort(sortChatsByLatest)
  const unpinned = chats.filter((c) => !pinnedSet.has(c.id)).sort(sortChatsByLatest)
  return [...pinned, ...unpinned]
}

export function ChatSidebar({
  userId,
  sharedKey,
  onPackSettingsChanged,
  onNavigate,
}: {
  userId: string
  sharedKey: CryptoKey | null
  onPackSettingsChanged?: () => void
  /** e.g. close mobile drawer after picking a chat */
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const peerPresence = useChatStore((s) => s.peerPresence)
  const { chats, reload } = useChats(userId)
  const [peerInput, setPeerInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trustedPeerIds, setTrustedPeerIds] = useState<Set<string>>(new Set())
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinnedIds)
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
        const next: Record<
          string,
          { username: string; avatar_key: string | null }
        > = {}
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

  function togglePin(chatId: string) {
    setPinnedIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId]
    )
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
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-neon-cyan/40 bg-black md:w-72 md:shrink-0">
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
      <div className="border-b border-neon-cyan/40 p-3 text-[10px] uppercase tracking-[0.3em] text-neon-cyan">
        :: {t('sidebar.channels')}
      </div>
      <nav className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
        {chats.length === 0 ? (
          <p className="px-3 py-2 font-mono text-[10px] text-red-800">
            {t('sidebar.noActiveRoutes')}
          </p>
        ) : null}
        {sidebarChats.map((c) => {
          const isPinned = pinnedIds.includes(c.id)
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
              className={`flex w-full items-stretch border-b border-neon-cyan/20 ${
                activeChatId === c.id ? 'bg-neon-cyan/15' : ''
              } ${isPinned ? 'border-l-2 border-l-neon-cyan/40' : ''}`}
            >
              <button
                type="button"
                className={`min-w-0 flex-1 px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan ${
                  activeChatId === c.id ? 'text-neon-cyan' : 'text-neon-red'
                }`}
                aria-label={`${t('common.openChatAria')} ${listTitle}`}
                onClick={() => {
                  setActiveChatId(c.id)
                  onNavigate?.()
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  {peerId ? (
                    <UserAvatar
                      userId={peerId}
                      username={peerName || '…'}
                      avatarKey={resolved?.avatar_key ?? null}
                      size={24}
                    />
                  ) : c.is_group ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center border border-neon-cyan/40 font-mono text-[9px] text-neon-cyan">
                      G
                    </span>
                  ) : null}
                  {!c.is_group &&
                  trustedPeerIds.has(
                    c.member_ids.find((id) => id !== userId) ?? ''
                  ) ? (
                    <ShieldCheck className="h-3.5 w-3.5 text-neon-cyan" />
                  ) : null}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="inline-flex items-center gap-1.5">
                      {pres?.online ? (
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]"
                          title={t('sidebar.online')}
                        />
                      ) : null}
                      <span className="truncate">
                        {c.is_group
                          ? `[${t('sidebar.badgeGroup')}]`
                          : `[${t('sidebar.badgeDirect')}]`}{' '}
                        {listTitle}
                      </span>
                    </span>
                    {pres && !pres.online ? (
                      <span className="text-[8px] normal-case tracking-normal text-red-900/90">
                        {t('sidebar.lastSeen')}:{' '}
                        {pres.last_seen_at
                          ? new Date(pres.last_seen_at).toLocaleString(
                              undefined,
                              {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              }
                            )
                          : '—'}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
              <button
                type="button"
                title={isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
                aria-label={
                  isPinned ? t('sidebar.unpinAria') : t('sidebar.pinAria')
                }
                onClick={(e) => {
                  e.stopPropagation()
                  togglePin(c.id)
                }}
                className="shrink-0 border-l border-neon-cyan/20 px-2 text-neon-cyan/70 hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <Pin
                  className={`h-3.5 w-3.5 ${isPinned ? 'text-neon-cyan' : 'text-neon-cyan/40'}`}
                  aria-hidden
                />
              </button>
            </div>
          )
        })}
      </nav>
      {activeChatId ? (
        <>
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
          <div className="flex gap-1 border-t border-neon-cyan/40 px-2 pt-2">
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
                    .catch((e) =>
                      setCreateErr(e instanceof Error ? e.message : 'ERR')
                    )
                    .finally(() => setBusy(false))
                }}
                className="flex-1 border border-red-900 bg-black py-1 font-mono text-[9px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red disabled:opacity-40"
              >
                [ {t('sidebar.leaveGroup')} ]
              </button>
            ) : null}
            {(() => {
              const row = chats.find((c) => c.id === activeChatId)
              const showDelete =
                !row?.is_group || row.my_role === 'owner'
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
                      .catch((e) =>
                        setCreateErr(e instanceof Error ? e.message : 'ERR')
                      )
                      .finally(() => setBusy(false))
                  }}
                  className="flex-1 border border-red-900 bg-black py-1 font-mono text-[9px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red disabled:opacity-40"
                >
                  [ {t('sidebar.deleteChat')} ]
                </button>
              )
            })()}
          </div>
        </>
      ) : null}
      <div className="border-t border-neon-cyan/40 p-2">
        <button
          type="button"
          aria-label={t('common.copyInviteAria')}
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
          className="mb-2 w-full rounded-none border border-neon-red/70 bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-red hover:bg-neon-red/10"
        >
          [ {t('sidebar.copyMyInvite')} ]
        </button>
        <button
          type="button"
          aria-label={t('common.createGroupAria')}
          onClick={() => setGroupModalOpen(true)}
          className="mb-2 w-full rounded-none border border-neon-cyan bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
        >
          [ {t('sidebar.createGroupE2e')} ]
        </button>
        <p className="mb-1 text-[10px] uppercase tracking-widest text-neon-cyan">
          :: {t('sidebar.openDirect')}
        </p>
        {createErr ? (
          <p className="mb-1 font-mono text-[10px] text-neon-red">
            {mapSidebarError(createErr)}
          </p>
        ) : null}
        <input
          className="terminal-input mb-2 text-xs"
          placeholder={t('sidebar.peerPlaceholder')}
          aria-label={t('common.peerInputAria')}
          value={peerInput}
          onChange={(e) => setPeerInput(e.target.value)}
        />
        <button
          type="button"
          onClick={() => void openDirect()}
          disabled={creating}
          className="w-full rounded-none border border-neon-red bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
        >
          [ {t('sidebar.openPeer')} ]
        </button>
      </div>
    </aside>
  )
}

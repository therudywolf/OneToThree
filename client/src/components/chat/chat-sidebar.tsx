'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Pin,
  ShieldCheck,
  Search,
  Loader2,
  MessageSquarePlus,
  Star,
  ShieldAlert,
  Bell,
  BellOff,
  UserCheck,
  Inbox,
  MessageSquare,
  Users,
  Megaphone,
  Radio,
  Folder,
} from 'lucide-react'
import Link from 'next/link'
import { useSessionStore } from '@/store/sessionStore'
import { usePresenceStore } from '@/store/presenceStore'
import { useUnreadStore } from '@/store/unreadStore'
import { createDirectE2EChat, leaveChat, deleteChat, fetchOrCreateSelfChat, setChatFavorite, setChatMute, isChatMuted } from '@/lib/api/chats'
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
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'
import { isApprovedContact } from '@/lib/contacts-store'
import {
  CHAT_FOLDERS_EVENT,
  deleteChatFolder,
  duplicateChatFolder,
  folderMatchesChat,
  loadChatFolders,
  reorderCustomFolders,
  resetChatFolderRules,
  type ChatFolder,
} from '@/lib/chat-folders'
import type { ApiChatRow } from '@/lib/api/chats'
import { searchLocalMessages, getLastCachedMessageForChat, MESSAGE_CACHED_EVENT } from '@/lib/message-cache'
import type { DecryptedMessage } from '@/types/chat'
import { parseStickerEnvelope } from '@/lib/attachment-envelope'
import { useThemeStore } from '@/store/themeStore'

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
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const setActiveChatId = useSessionStore((s) => s.setActiveChatId)
  const peerPresence = usePresenceStore((s) => s.peerPresence)
  const unreadByChat = useUnreadStore((s) => s.unreadByChat)
  const { chats, reload, initialLoading, patchChat } = useChats(userId)
  const [peerInput, setPeerInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trustedPeerIds, setTrustedPeerIds] = useState<Set<string>>(new Set())
  const [approvedPeerIds, setApprovedPeerIds] = useState<Set<string>>(new Set())
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinnedIds)
  const [localGhostQuery, setLocalGhostQuery] = useState('')
  const [ghostHitChatIds, setGhostHitChatIds] = useState<Set<string> | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [peerLookupByUserId, setPeerLookupByUserId] = useState<
    Record<string, { username: string; avatar_key: string | null }>
  >({})
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [activeFolderId, setActiveFolderId] = useState('all')
  const folderButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [dragFolderId, setDragFolderId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null)
  const [_renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [_renamingFolderName, setRenamingFolderName] = useState('')
  const [lastMessages, setLastMessages] = useState<Record<string, DecryptedMessage | null>>({})

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

  useEffect(() => {
    const apply = () => {
      const loaded = loadChatFolders()
      setFolders(loaded)
      if (!loaded.some((f) => f.id === activeFolderId)) {
        setActiveFolderId('all')
      }
    }
    apply()
    const onUpdate = () => apply()
    const onStorage = (ev: StorageEvent) => {
      if (ev.key && !ev.key.includes('p13_chat_folders')) return
      apply()
    }
    window.addEventListener(CHAT_FOLDERS_EVENT, onUpdate)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHAT_FOLDERS_EVENT, onUpdate)
      window.removeEventListener('storage', onStorage)
    }
  }, [activeFolderId])

  useEffect(() => {
    const node = folderButtonRefs.current[activeFolderId]
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeFolderId])

  useEffect(() => {
    if (!folderMenu) return
    const onGlobalClick = () => setFolderMenu(null)
    window.addEventListener('click', onGlobalClick)
    return () => window.removeEventListener('click', onGlobalClick)
  }, [folderMenu])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = folders.find((f) => f.id === activeFolderId)
      if (!active || active.isSystem) return
      if (e.key === 'F2') {
        e.preventDefault()
        setRenamingFolderId(active.id)
        setRenamingFolderName(active.name)
      }
      if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ok = window.confirm(`Удалить папку "${active.name}"?`)
        if (!ok) return
        deleteChatFolder(active.id)
        const next = loadChatFolders()
        setFolders(next)
        setActiveFolderId('all')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeFolderId, folders])

  useEffect(() => {
    const directPeerIds = chats
      .filter((c) => !c.is_group)
      .map((c) => c.member_ids.find((id) => id !== userId))
      .filter((id): id is string => Boolean(id))
    if (!directPeerIds.length) {
      setApprovedPeerIds(new Set())
      return
    }
    const approved = new Set<string>()
    for (const peerId of directPeerIds) {
      if (isApprovedContact(peerId)) approved.add(peerId)
    }
    setApprovedPeerIds(approved)
  }, [chats, userId])

  useEffect(() => {
    if (!chats.length) return
    let cancelled = false
    void Promise.all(
      chats.map(async (c) => ({ id: c.id, msg: await getLastCachedMessageForChat(c.id) }))
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, DecryptedMessage | null> = {}
      for (const r of results) next[r.id] = r.msg
      setLastMessages(next)
    })
    return () => { cancelled = true }
  }, [chats])

  useEffect(() => {
    const onCached = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId: string }>).detail?.chatId
      if (!chatId) return
      void getLastCachedMessageForChat(chatId).then((msg) => {
        setLastMessages((prev) => ({ ...prev, [chatId]: msg }))
      })
    }
    window.addEventListener(MESSAGE_CACHED_EVENT, onCached)
    return () => window.removeEventListener(MESSAGE_CACHED_EVENT, onCached)
  }, [])

  function formatChatTs(iso: string | null | undefined): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  function previewText(c: { id: string; type: string; last_message_at?: string | null }): string {
    const msg = lastMessages[c.id]
    if (!msg) return c.last_message_at ? '…' : ''
    if (msg.media_type === 'image') return '📷 Photo'
    if (msg.media_type === 'audio') return '🎵 Audio'
    if (msg.media_type === 'video') return '🎬 Video'
    if (msg.media_type === 'file') return '📎 File'
    const st = msg.plaintext ? parseStickerEnvelope(msg.plaintext) : null
    if (st) {
      return st.fallbackEmoji?.trim()
        ? `${st.fallbackEmoji} · ${t('chat.previewSticker')}`
        : t('chat.previewSticker')
    }
    return msg.plaintext?.slice(0, 60) ?? ''
  }

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

  const nonSelfChats = sidebarChats.filter((c) => !isSavedMessagesChat(c, userId))

  const activeFolder = folders.find((f) => f.id === activeFolderId) ?? folders[0] ?? null
  const folderFilteredChats = activeFolder
    ? nonSelfChats.filter((c) =>
      folderMatchesChat(activeFolder, c, userId, {
        unreadTotal: unreadByChat[c.id]?.total ?? 0,
        muted: isChatMuted(c),
      })
    )
    : nonSelfChats

  const sidebarChatsFiltered =
    ghostHitChatIds === null
      ? folderFilteredChats
      : folderFilteredChats.filter((c) => ghostHitChatIds.has(c.id))

  function togglePin(chatId: string) {
    setPinnedIds((prev) =>
      prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId]
    )
  }

  function folderIcon(folder: ChatFolder) {
    if (folder.id === 'all') return Inbox
    if (folder.id === 'unread') return MessageSquare
    if (folder.id === 'direct') return Users
    if (folder.id === 'groups') return Users
    if (folder.id === 'channels') return Megaphone
    if (folder.id === 'channels_broadcast') return Radio
    return Folder
  }

  async function toggleFavorite(chatId: string, current: boolean) {
    const next = !current
    patchChat(chatId, {
      is_favorite: next,
      favorited_at: next ? new Date().toISOString() : null,
    })
    try {
      await setChatFavorite(chatId, next)
      await reload()
    } catch (e) {
      await reload()
      setCreateErr(e instanceof Error ? e.message : 'ERR')
    }
  }

  async function toggleMute(chatId: string, currentlyMuted: boolean) {
    try {
      // Toggle semantics: if currently muted, clear; otherwise mute "forever"
      // (client-local UX — a future upgrade can open a timer picker).
      await setChatMute(chatId, currentlyMuted ? null : 'forever')
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

  const visibleFolders = folders.length
    ? folders
    : [{ id: 'all', name: t('sidebar.channels'), chatIds: [], excludedChatIds: [], isSystem: true, rule: { includeDirect: true, includeGroups: true, includeChannels: true, includeSaved: false, includeMuted: true, includeRead: true } }]

  return (
    <aside className={`relative flex h-full w-full min-w-0 flex-row md:w-[21.5rem] md:shrink-0 ${isMd3 ? 'border-r border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] bg-[var(--surface)]' : 'border-r border-neon-cyan/30 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_92%,transparent),color-mix(in_srgb,var(--void)_84%,transparent))] backdrop-blur-xl shadow-[8px_0_40px_rgba(0,0,0,0.32),1px_0_0_rgba(255,255,255,0.02)]'}`}>
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

      {/* Vertical folder rail — Telegram-style left column */}
      <nav className={`custom-scrollbar flex shrink-0 flex-col items-center gap-0.5 overflow-y-auto py-2 w-14 ${isMd3 ? 'border-r border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]' : 'border-r border-neon-cyan/15'}`}>
        {visibleFolders.map((folder) => {
          const matchingChats = nonSelfChats.filter((c) =>
            folderMatchesChat(folder, c, userId, {
              unreadTotal: unreadByChat[c.id]?.total ?? 0,
              muted: isChatMuted(c),
            })
          )
          const unreadCount = matchingChats.reduce((acc, c) => acc + (unreadByChat[c.id]?.total ?? 0), 0)
          const mentionCount = matchingChats.reduce((acc, c) => acc + (unreadByChat[c.id]?.mentions ?? 0), 0)
          const Icon = folderIcon(folder)
          const isActive = activeFolderId === folder.id
          return (
            <button
              key={folder.id}
              type="button"
              ref={(el) => { folderButtonRefs.current[folder.id] = el }}
              title={folder.name}
              draggable={!folder.isSystem}
              onDragStart={(e) => {
                if (folder.isSystem) return
                setDragFolderId(folder.id)
                e.dataTransfer.setData('text/folder-id', folder.id)
              }}
              onDragOver={(e) => {
                if (!dragFolderId || dragFolderId === folder.id || folder.isSystem) return
                e.preventDefault()
                setDragOverFolderId(folder.id)
              }}
              onDragLeave={() => setDragOverFolderId((prev) => (prev === folder.id ? null : prev))}
              onDrop={(e) => {
                if (folder.isSystem) return
                const sourceId = e.dataTransfer.getData('text/folder-id')
                if (!sourceId || sourceId === folder.id) return
                reorderCustomFolders(sourceId, folder.id)
                setFolders(loadChatFolders())
                setDragFolderId(null)
                setDragOverFolderId(null)
              }}
              onDragEnd={() => { setDragFolderId(null); setDragOverFolderId(null) }}
              onContextMenu={(e) => {
                if (folder.isSystem) return
                e.preventDefault()
                setFolderMenu({ folderId: folder.id, x: e.clientX, y: e.clientY })
              }}
              onDoubleClick={() => {
                if (folder.isSystem) return
                setRenamingFolderId(folder.id)
                setRenamingFolderName(folder.name)
              }}
              onClick={() => setActiveFolderId(folder.id)}
              className={`relative flex flex-col items-center justify-center w-10 h-10 rounded-xl transition-all ${
                isActive
                  ? isMd3
                    ? 'bg-[var(--neon-red)] text-[var(--surface)]'
                    : 'bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/40'
                  : isMd3
                    ? 'text-[var(--on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                    : 'text-text-muted/60 hover:text-neon-cyan hover:bg-neon-cyan/8'
              } ${dragOverFolderId === folder.id ? (isMd3 ? 'ring-2 ring-[var(--neon-red)]' : 'ring-2 ring-neon-cyan') : ''}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {(unreadCount > 0 || mentionCount > 0) && !isActive ? (
                <span className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[8px] font-bold ${isMd3 ? 'bg-[var(--neon-red)] text-[var(--surface)]' : 'bg-neon-red text-text-primary'}`}>
                  {mentionCount > 0 ? `@${mentionCount > 9 ? '9+' : mentionCount}` : unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>
      {folderMenu ? (
        <div
          className="fixed z-[220] min-w-[11rem] border border-border-strong bg-surface p-1 shadow-2xl"
          style={{ left: folderMenu.x, top: folderMenu.y }}
          onMouseLeave={() => setFolderMenu(null)}
        >
          <button type="button" className="block w-full px-2 py-1 text-left text-[10px] hover:bg-neon-cyan/10"
            onClick={() => {
              const folder = folders.find((f) => f.id === folderMenu.folderId)
              if (!folder || folder.isSystem) return
              setRenamingFolderId(folder.id)
              setRenamingFolderName(folder.name)
              setFolderMenu(null)
            }}>Переименовать</button>
          <button type="button" className="block w-full px-2 py-1 text-left text-[10px] hover:bg-neon-cyan/10"
            onClick={() => {
              const copy = duplicateChatFolder(folderMenu.folderId)
              if (copy) { setFolders(loadChatFolders()); setActiveFolderId(copy.id) }
              setFolderMenu(null)
            }}>Дублировать</button>
          <button type="button" className="block w-full px-2 py-1 text-left text-[10px] hover:bg-neon-cyan/10"
            onClick={() => { resetChatFolderRules(folderMenu.folderId); setFolders(loadChatFolders()); setFolderMenu(null) }}>Сбросить правила</button>
          <button type="button" className="block w-full px-2 py-1 text-left text-[10px] hover:bg-neon-cyan/10"
            onClick={() => {
              deleteChatFolder(folderMenu.folderId)
              setFolders(loadChatFolders())
              if (activeFolderId === folderMenu.folderId) setActiveFolderId('all')
              setFolderMenu(null)
            }}>Удалить</button>
        </div>
      ) : null}

      {/* Right panel — search + chat list + compose */}
      <div className="flex flex-col flex-1 min-w-0">
      <div
        className={`sticky top-0 z-10 border-b px-4 py-2 ${
          isMd3
            ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] bg-[var(--surface)]'
            : 'border-neon-cyan/30 bg-void'
        }`}
      >
        <p className={`${isMd3 ? 'text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--on-surface)]' : 'font-mono text-[11px] uppercase tracking-[0.3em] text-neon-cyan'}`}>
          {t('sidebar.channels')}
        </p>
      </div>

      {/* Search */}
      <div className={`border-b px-4 py-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] bg-[var(--surface)]' : 'border-neon-cyan/15 bg-void/25'}`}>
        <label className="sr-only" htmlFor="ghost-search">
          {t('sidebar.localGhostSearch')}
        </label>
        <div className={`relative flex items-center overflow-hidden border ${isMd3 ? 'rounded-full border-transparent bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] shadow-none' : 'rounded-2xl border-border-strong/5 bg-surface/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'}`}>
          {isSearching ? (
            <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin text-neon-cyan/50" />
          ) : (
            <Search className="absolute left-3 h-3.5 w-3.5 text-neon-cyan/50" />
          )}
          <input
            id="ghost-search"
            className={`w-full bg-transparent px-3 py-2 pl-9 text-[11px] focus:outline-none ${isMd3 ? 'text-[var(--on-surface)] placeholder:text-text-muted' : 'text-neon-cyan placeholder:text-neon-cyan/30'}`}
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
          const existingSelf = chats.find((c) => isSavedMessagesChat(c, userId))
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
            console.error('[saved-messages] open failed', err)
            // Re-throw so React error boundary can surface it; swallowing made
            // the button look dead in the wild.
          }
        }}
        className={`mx-3 mt-3 flex items-center gap-2 px-3 py-2.5 text-left text-[10px] transition-colors ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'border border-accent-2/40 bg-[linear-gradient(180deg,rgba(255,191,0,0.08),rgba(255,191,0,0.03))] font-mono uppercase tracking-widest text-neon-cyan/80 hover:border-accent-2/40 hover:bg-accent-2/15 hover:text-neon-cyan'}`}
      >
        <Star className="h-3.5 w-3.5 text-accent-2 fill-accent-2" />
        {t('sidebar.savedMessages')}
      </button>

      {/* Chat List */}
      <nav className="custom-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain px-3 pb-3 pt-3 [-webkit-overflow-scrolling:touch]">
        {initialLoading ? (
          <div className="space-y-2 py-1">
            {Array.from({ length: 5 }, (_, i) => (
              <ChatRowSkeleton key={i} />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className={`px-4 py-8 text-center space-y-3 ${isMd3 ? 'md3-empty-state' : ''}`}>
            <p className={`${isMd3 ? 'text-[15px] font-medium text-[var(--on-surface)]' : 'font-mono text-[10px] uppercase tracking-widest text-text-muted/70'}`}>
              {t('sidebar.noActiveRoutes')}
            </p>
            <p className={`${isMd3 ? 'text-[13px] text-text-muted' : 'text-[9px] text-text-muted/70'}`}>
              {t('chat.startChatHint')}
            </p>
            <button
              type="button"
              onClick={() => setGroupModalOpen(true)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                isMd3
                  ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)] shadow-[var(--md3-elevation-2)] hover:brightness-110'
                  : 'border border-neon-cyan/50 bg-void font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'
              }`}
            >
              <MessageSquarePlus className="h-3 w-3" />
              {t('chat.newChat')}
            </button>
          </div>
        ) : null}

        {ghostHitChatIds !== null &&
        localGhostQuery.trim().length >= 2 &&
        sidebarChatsFiltered.length === 0 ? (
            <p className="mx-1 mt-2 border border-neon-red/30 bg-danger/30 px-4 py-6 text-center font-mono text-[10px] uppercase tracking-widest text-neon-red">
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
              data-chat-list-item
              data-active={activeChatId === c.id ? 'true' : 'false'}
              className={`p13-sidebar-row chat-list-item group overflow-hidden ${
                isPinned ? 'ring-1 ring-inset ring-[color:var(--neon-cyan)]/20' : ''
              }`}
            >
              <button
                type="button"
                className={`min-w-0 flex-1 px-3 py-3 text-left text-xs outline-none ${isMd3 ? 'font-sans' : 'font-mono'}`}
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

                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {/* Row 1: name + timestamp */}
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {!c.is_group && trustedPeerIds.has(peerId ?? '') ? (
                        <ShieldCheck className="h-3 w-3 text-neon-cyan shrink-0" />
                      ) : null}
                      {!c.is_group && approvedPeerIds.has(peerId ?? '') ? (
                        <UserCheck className="h-3 w-3 text-accent-2 shrink-0" />
                      ) : null}
                      <span className={`truncate text-[12px] font-medium ${activeChatId === c.id ? (isMd3 ? 'font-semibold text-[var(--on-surface)]' : 'font-semibold text-neon-cyan') : (isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan/85')}`}>
                        {listTitle}
                      </span>
                      {isPinned ? (
                        <Pin className="h-2.5 w-2.5 shrink-0 text-neon-cyan/60" />
                      ) : null}
                      <span className={`ml-auto shrink-0 text-[10px] ${isMd3 ? 'text-text-muted' : 'text-text-muted/70'}`}>
                        {formatChatTs(lastMessages[c.id]?.created_at ?? c.last_message_at)}
                      </span>
                    </span>

                    {/* Row 2: last message preview + unread badge */}
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <span className={`truncate text-[11px] ${isMd3 ? 'text-text-muted' : 'text-text-muted/60'}`}>
                        {previewText(c) || (
                          pres && !pres.online ? (
                            <>
                              {t('sidebar.lastSeen')}{' '}
                              {pres.last_seen_at
                                ? new Date(pres.last_seen_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : '—'}
                            </>
                          ) : c.is_group ? `${c.member_ids.length} ${t('sidebar.members')}` : ''
                        )}
                      </span>
                      {unreadTotal > 0 ? (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
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
                          <span className={`px-1.5 py-[1px] text-[9px] font-bold ${isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'rounded border border-neon-cyan/60 bg-void text-neon-cyan'}`}>
                            {unreadTotal > 99 ? '99+' : unreadTotal}
                          </span>
                        </span>
                      ) : null}
                    </span>
                  </span>
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
              {(() => {
                const muted = isChatMuted(c)
                return (
                  <button
                    type="button"
                    title={muted ? t('sidebar.unmute') : t('sidebar.mute')}
                    aria-pressed={muted}
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleMute(c.id, muted)
                    }}
                    className={`shrink-0 border-l border-border-strong/5 px-3 transition-colors ${
                      muted
                        ? 'text-text-muted bg-text-muted/10 hover:bg-neon-red/10 hover:text-neon-red'
                        : 'text-text-muted/70 hover:bg-neon-cyan/10 hover:text-neon-cyan opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    {muted ? (
                      <BellOff className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Bell className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                )
              })()}
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
                  className={`flex-1 py-1.5 text-[9px] transition-colors disabled:opacity-40 ${
                    isMd3
                      ? 'rounded-full border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]'
                      : 'border border-danger/40 bg-void font-mono uppercase tracking-widest text-danger hover:border-neon-red hover:bg-neon-red/10'
                  }`}
                >
                  {t('sidebar.deleteChat')}
                </button>
              )
            })()}
          </div>
        </div>
      ) : null}

      {/* Global Actions */}
      <div className={`border-t p-3 space-y-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] bg-[var(--surface)]' : 'border-neon-cyan/20 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_55%,transparent),color-mix(in_srgb,var(--void)_94%,transparent))]'}`}>

        {/* Admin link — only for admins, mobile-first placement */}
        {isAdmin ? (
          <Link
            href="/admin"
            className={`flex items-center gap-2 w-full px-3 py-2 transition-colors ${
              isMd3
                ? 'rounded-2xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)]'
                : 'border border-danger/40 bg-void font-mono text-[10px] uppercase tracking-widest text-danger hover:border-neon-red hover:bg-neon-red/10 hover:text-neon-red'
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{isMd3 ? 'Warden' : '[ WARDEN ]'}</span>
          </Link>
        ) : null}

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
              className={`w-full px-2 py-1 text-[10px] ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] placeholder:text-text-muted focus:outline-none' : 'terminal-input placeholder:text-neon-cyan/30'}`}
              placeholder={t('sidebar.peerPlaceholder')}
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value)}
              spellCheck="false"
            />
            <button
              type="button"
              onClick={() => void openDirect()}
              disabled={creating || !peerInput.trim()}
              className={`shrink-0 px-3 text-[10px] transition-colors disabled:opacity-40 ${isMd3 ? 'inline-flex items-center gap-1.5 rounded-2xl bg-[var(--neon-red)] text-[var(--surface)] shadow-[var(--md3-elevation-2)] hover:brightness-110 disabled:hover:bg-[var(--neon-red)]' : 'border border-neon-cyan bg-void font-mono uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan hover:text-text-primary disabled:hover:bg-void disabled:hover:text-neon-cyan'}`}
            >
              {isMd3 ? <MessageSquarePlus className="h-4 w-4" aria-hidden /> : null}
              {t('sidebar.openPeer')}
            </button>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-neon-cyan/20">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setGroupModalOpen(true)}
              className={`flex-1 py-2 text-[10px] transition-colors ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'border border-neon-cyan/50 bg-void font-mono uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'}`}
            >
              {t('sidebar.createGroupE2e')}
            </button>
            <button
              type="button"
              onClick={() => setGroupModalOpen(true)}
              className={`flex-1 py-2 text-[10px] transition-colors ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'border border-neon-cyan/50 bg-void font-mono uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'}`}
            >
              {t('sidebar.createChannel')}
            </button>
          </div>
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
            className={`w-full py-2 text-[10px] transition-colors ${isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)] shadow-[var(--md3-elevation-1)] hover:brightness-110' : 'border border-neon-cyan/50 bg-void font-mono uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'}`}
          >
            {t('sidebar.copyMyInvite')}
          </button>
        </div>
      </div>

      </div>{/* end right panel */}
    </aside>
  )
}

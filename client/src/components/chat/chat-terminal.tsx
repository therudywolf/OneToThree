'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Crown, Star } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { MediaMessage } from '@/components/chat/media-message'
import { deleteMessage } from '@/lib/api/chats'
import {
  deleteCachedMessage,
  getOlderCachedMessages,
} from '@/lib/message-cache'
import { lookupUsers } from '@/lib/api/users'
import type { ApiChatRow, ChatMemberRole } from '@/lib/api/chats'
import type { DecryptedMessage } from '@/types/chat'

const OLDER_PAGE_SIZE = 25
const OLDER_RAM_CAP = 200

function shortId(id: string) {
  return `${id.slice(0, 8)}…`
}

export function ChatTerminal({
  userId,
  sharedKey,
  currentUsername,
  activeChat,
  directPeerUsername,
  senderRoles = {},
}: {
  userId: string
  sharedKey: CryptoKey | null
  currentUsername: string
  activeChat: ApiChatRow | null
  /** Resolved peer handle for direct chats; null while loading. */
  directPeerUsername: string | null
  /** Group chats: user_id → pack role (for header badges). */
  senderRoles?: Record<string, ChatMemberRole>
}) {
  const messages = useChatStore((s) => s.messages)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const typingUsers = useChatStore((s) => s.typingUsers)
  const ref = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const [olderMessages, setOlderMessages] = useState<DecryptedMessage[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  const [ctxMenu, setCtxMenu] = useState<{
    msg: DecryptedMessage
    x: number
    y: number
    isMine: boolean
  } | null>(null)

  const isGroup = activeChat?.is_group ?? false

  const renderMessages = useMemo(() => {
    const map = new Map<string, DecryptedMessage>()
    for (const m of [...olderMessages, ...messages]) {
      map.set(m.id, m)
    }
    return [...map.values()].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
  }, [olderMessages, messages])

  const senderIdsToResolve = useMemo(() => {
    if (!isGroup || !activeChatId) return []
    const ids = new Set<string>()
    for (const m of renderMessages) {
      if (m.sender_id !== userId) ids.add(m.sender_id)
    }
    return [...ids]
  }, [isGroup, activeChatId, renderMessages, userId])

  useEffect(() => {
    if (!senderIdsToResolve.length) {
      setSenderNames({})
      return
    }
    let cancelled = false
    void lookupUsers(senderIdsToResolve)
      .then((rows) => {
        if (cancelled) return
        const next: Record<string, string> = {}
        for (const u of rows) {
          next[u.id] = u.username
        }
        setSenderNames(next)
      })
      .catch(() => {
        if (!cancelled) setSenderNames({})
      })
    return () => {
      cancelled = true
    }
  }, [senderIdsToResolve])

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [messages])

  useEffect(() => {
    setOlderMessages([])
    setHasMoreOlder(true)
    setLoadingOlder(false)
  }, [activeChatId])

  useEffect(() => {
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const msgById = (id: string) => renderMessages.find((m) => m.id === id)
  const oldestLoaded = renderMessages[0] ?? null
  const typingNow = activeChatId
    ? Object.values(typingUsers[activeChatId] ?? {}).map((v) => v.username)
    : []

  function labelForSender(senderId: string): string {
    if (senderId === userId) {
      return currentUsername.trim() || 'YOU'
    }
    if (!isGroup) {
      return directPeerUsername?.trim() || shortId(senderId)
    }
    return senderNames[senderId]?.trim() || shortId(senderId)
  }

  function roleGlyph(senderId: string) {
    if (!isGroup) return null
    const r = senderRoles[senderId]
    if (r === 'owner') {
      return (
        <Crown
          className="inline h-3 w-3 shrink-0 align-middle text-neon-cyan"
          aria-label="owner"
        />
      )
    }
    if (r === 'admin') {
      return (
        <Star
          className="inline h-3 w-3 shrink-0 align-middle text-neon-cyan/90"
          aria-label="admin"
        />
      )
    }
    return null
  }

  useEffect(() => {
    if (!activeChatId || !topSentinelRef.current || !ref.current) return
    const io = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (!first?.isIntersecting) return
        if (loadingOlder || !hasMoreOlder || !oldestLoaded) return
        setLoadingOlder(true)
        void getOlderCachedMessages({
          chatId: activeChatId,
          beforeCreatedAt: oldestLoaded.created_at,
          beforeId: oldestLoaded.id,
          limit: OLDER_PAGE_SIZE,
        })
          .then((rows) => {
            if (!rows.length) {
              setHasMoreOlder(false)
              return
            }
            setOlderMessages((prev) => {
              const merged = [...rows, ...prev]
              if (merged.length <= OLDER_RAM_CAP) return merged
              return merged.slice(0, OLDER_RAM_CAP)
            })
            if (rows.length < OLDER_PAGE_SIZE) {
              setHasMoreOlder(false)
            }
          })
          .finally(() => setLoadingOlder(false))
      },
      { root: ref.current, threshold: 0.05 }
    )
    io.observe(topSentinelRef.current)
    return () => io.disconnect()
  }, [activeChatId, hasMoreOlder, loadingOlder, oldestLoaded])

  if (!activeChatId) {
    return (
      <div className="crt-terminal-vignette flex flex-1 items-center justify-center bg-black font-mono text-xs text-red-800">
        <div className="max-w-xs space-y-3 text-center">
          <p className="text-sm text-neon-cyan/60">NO_ACTIVE_CHANNEL</p>
          <p className="text-[10px] text-red-900">
            Select or create a secure channel from the sidebar
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="crt-terminal-vignette relative min-h-0 flex-1 overflow-hidden bg-black">
      {ctxMenu ? (
        <div
          className="fixed z-50 border border-neon-red bg-black shadow-lg"
          role="menu"
          aria-label="Message actions"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2 text-left font-mono text-[10px] uppercase text-neon-cyan hover:bg-neon-cyan/10"
            onClick={(e) => {
              e.stopPropagation()
              setReplyTo(ctxMenu.msg)
              setCtxMenu(null)
            }}
          >
            Reply
          </button>
          {ctxMenu.isMine ? (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-4 py-2 text-left font-mono text-[10px] uppercase text-neon-red hover:bg-neon-red/10"
              onClick={(e) => {
                e.stopPropagation()
                void deleteMessage(ctxMenu.msg.id, true).then(() =>
                  removeMessage(ctxMenu.msg.id)
                )
                void deleteCachedMessage(ctxMenu.msg.id)
                setCtxMenu(null)
              }}
            >
              Delete for everyone
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2 text-left font-mono text-[10px] uppercase text-red-800 hover:bg-neon-red/10"
            onClick={(e) => {
              e.stopPropagation()
              removeMessage(ctxMenu.msg.id)
              void deleteCachedMessage(ctxMenu.msg.id)
              setCtxMenu(null)
            }}
          >
            Delete for me
          </button>
        </div>
      ) : null}
      <div
        ref={ref}
        className="h-full overflow-y-auto px-4 py-3 font-mono text-sm text-neon-red"
      >
        <div ref={topSentinelRef} className="h-1 w-full" aria-hidden />
        {renderMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="space-y-2 text-center">
              <p className="text-xs text-neon-cyan/40">NO_PACKETS</p>
              <p className="text-[9px] text-red-900">
                Encrypted channel is empty. Send the first message.
              </p>
            </div>
          </div>
        ) : null}
        {renderMessages.map((m) => {
          const replyMsg = m.reply_to_id ? msgById(m.reply_to_id) : null
          const mine = m.sender_id === userId
          const senderLabel = labelForSender(m.sender_id)
          return (
            <div
              key={m.id}
              className={`group mb-3 flex w-full ${mine ? 'justify-end' : 'justify-start'}`}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({
                  msg: m,
                  x: e.clientX,
                  y: e.clientY,
                  isMine: mine,
                })
              }}
            >
              <div
                className={`max-w-[min(100%,42rem)] min-w-0 ${
                  mine ? 'items-end' : 'items-start'
                } flex flex-col gap-1`}
              >
                <div
                  className={`flex items-center gap-1 px-1 font-mono text-[10px] uppercase tracking-widest ${
                    mine ? 'justify-end text-right text-neon-cyan/70' : 'justify-start text-left text-neon-cyan/80'
                  }`}
                >
                  {roleGlyph(m.sender_id)}
                  <span>{senderLabel}</span>
                </div>
                <div
                  className={`w-full rounded-none border px-3 py-2 ${
                    mine
                      ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                      : 'border-neon-cyan/25 bg-black/80 text-neon-red'
                  }`}
                >
                  {replyMsg ? (
                    <div className="mb-1 border-l border-neon-cyan/30 pl-2 text-[10px] text-neon-cyan/60">
                      <span className="text-red-800">
                        ↳ {labelForSender(replyMsg.sender_id)}:
                      </span>{' '}
                      {replyMsg.plaintext
                        ? replyMsg.plaintext.slice(0, 60) +
                          (replyMsg.plaintext.length > 60 ? '…' : '')
                        : '[MEDIA]'}
                    </div>
                  ) : m.reply_to_id ? (
                    <div className="mb-1 text-[10px] text-red-900">
                      ↳ [ORIGINAL_DELETED]
                    </div>
                  ) : null}
                  <div className="mb-1 text-[9px] text-red-800/90">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                  {m.plaintext ? (
                    <div className="whitespace-pre-wrap break-words">{m.plaintext}</div>
                  ) : null}
                  {m.media_path && m.media_iv && m.media_type ? (
                    <MediaMessage message={m} sharedKey={sharedKey} />
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
        {typingNow.length > 0 ? (
          <div className="sticky bottom-0 mt-2 border-t border-neon-cyan/20 bg-black/90 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
            [ @{typingNow[0]} IS TYPING
            <span className="animate-pulse">...</span> ]
          </div>
        ) : null}
      </div>
    </div>
  )
}

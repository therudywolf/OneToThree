'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, CheckCheck, Crown, Star } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { MediaMessage } from '@/components/chat/media-message'
import { deleteMessage } from '@/lib/api/chats'
import {
  deleteCachedMessage,
  getOlderCachedMessages,
} from '@/lib/message-cache'
import { lookupUsers } from '@/lib/api/users'
import { UserAvatar } from '@/components/user-avatar'
import type { ApiChatRow, ChatMemberRole } from '@/lib/api/chats'
import { useReadReceipts } from '@/hooks/use-read-receipts'
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
  myAvatarKey = null,
  peerAvatarKey = null,
}: {
  userId: string
  sharedKey: CryptoKey | null
  currentUsername: string
  activeChat: ApiChatRow | null
  /** Resolved peer handle for direct chats; null while loading. */
  directPeerUsername: string | null
  /** Group chats: user_id → pack role (for header badges). */
  senderRoles?: Record<string, ChatMemberRole>
  myAvatarKey?: string | null
  peerAvatarKey?: string | null
}) {
  const messages = useChatStore((s) => s.messages)
  const readAtOverrides = useChatStore((s) => s.readAtOverrides)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const ref = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const [olderMessages, setOlderMessages] = useState<DecryptedMessage[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [senderMeta, setSenderMeta] = useState<
    Record<string, { username: string; avatar_key?: string | null }>
  >({})
  const [ctxMenu, setCtxMenu] = useState<{
    msg: DecryptedMessage
    x: number
    y: number
    isMine: boolean
  } | null>(null)

  const isGroup = activeChat?.is_group ?? false

  useReadReceipts(ref, { enabled: !isGroup })

  const renderMessages = useMemo(() => {
    const map = new Map<string, DecryptedMessage>()
    for (const m of [...olderMessages, ...messages]) {
      map.set(m.id, m)
    }
    return [...map.values()]
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      .map((m) => ({
        ...m,
        read_at: m.read_at ?? readAtOverrides[m.id] ?? null,
      }))
  }, [olderMessages, messages, readAtOverrides])

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
      setSenderMeta({})
      return
    }
    let cancelled = false
    void lookupUsers(senderIdsToResolve)
      .then((rows) => {
        if (cancelled) return
        const next: Record<string, { username: string; avatar_key?: string | null }> =
          {}
        for (const u of rows) {
          next[u.id] = { username: u.username, avatar_key: u.avatar_key }
        }
        setSenderMeta(next)
      })
      .catch(() => {
        if (!cancelled) setSenderMeta({})
      })
    return () => {
      cancelled = true
    }
  }, [senderIdsToResolve])

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, activeChatId])

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
  function labelForSender(senderId: string): string {
    if (senderId === userId) {
      return currentUsername.trim() || 'YOU'
    }
    if (!isGroup) {
      return directPeerUsername?.trim() || shortId(senderId)
    }
    return senderMeta[senderId]?.username?.trim() || shortId(senderId)
  }

  function avatarKeyForSender(senderId: string): string | null | undefined {
    if (senderId === userId) return myAvatarKey ?? null
    if (!isGroup) return peerAvatarKey ?? null
    return senderMeta[senderId]?.avatar_key
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
        <div className="max-w-xs space-y-3 border border-neon-cyan/20 px-6 py-4 text-center">
          <p className="text-sm tracking-[0.2em] text-neon-cyan/50">
            WAITING FOR SIGNAL
          </p>
          <p className="text-[10px] uppercase tracking-widest text-red-900">
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
          <div className="flex h-full min-h-[12rem] items-center justify-center">
            <div className="space-y-2 border border-neon-cyan/20 px-6 py-4 text-center">
              <p className="font-mono text-xs tracking-[0.25em] text-neon-cyan/50">
                NO LOGS FOUND
              </p>
              <p className="text-[9px] uppercase tracking-widest text-red-900">
                Waiting for signal — send the first packet.
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
              data-message-id={m.id}
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
                  className={`flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-widest ${
                    mine
                      ? 'flex-row-reverse justify-end text-right text-neon-cyan/70'
                      : 'justify-start text-left text-neon-cyan/80'
                  }`}
                >
                  {!mine ? (
                    <UserAvatar
                      userId={m.sender_id}
                      username={labelForSender(m.sender_id)}
                      avatarKey={avatarKeyForSender(m.sender_id)}
                      size={22}
                    />
                  ) : (
                    <UserAvatar
                      userId={userId}
                      username={currentUsername || 'YOU'}
                      avatarKey={myAvatarKey}
                      size={22}
                    />
                  )}
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
                  {mine && !isGroup ? (
                    <div
                      className="mt-1 flex items-center justify-end gap-0.5 text-[10px]"
                      aria-hidden
                    >
                      {m.read_at ? (
                        <CheckCheck className="h-3.5 w-3.5 text-cyan-400 drop-shadow-[0_0_4px_rgba(34,211,238,0.5)]" />
                      ) : (
                        <Check className="h-3 w-3 text-zinc-500" />
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} className="h-px w-full shrink-0" aria-hidden />
      </div>
    </div>
  )
}

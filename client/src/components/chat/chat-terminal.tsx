'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, CheckCheck, Crown, Star, X } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { MediaMessage } from '@/components/chat/media-message'
import { ChatInput } from '@/components/chat/chat-input'
import { parseAttachmentEnvelope } from '@/lib/attachment-envelope'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { deleteMessage } from '@/lib/api/chats'
import {
  deleteCachedMessage,
  getOlderCachedMessages,
} from '@/lib/message-cache'
import { lookupUsers } from '@/lib/api/users'
import { NoirPlaintext } from '@/components/chat/noir-plaintext'
import { UserAvatar } from '@/components/user-avatar'
import type { ApiChatRow, ChatMemberRole } from '@/lib/api/chats'
import { useReadReceipts } from '@/hooks/use-read-receipts'
import { useTranslation } from '@/hooks/use-translation'
import type { DecryptedMessage } from '@/types/chat'
import { MediaLightbox } from '@/components/chat/media-lightbox'
import { groupMessages } from '@/lib/message-grouping'

const OLDER_PAGE_SIZE = 25
const OLDER_RAM_CAP = 200

function shortId(id: string) {
  return `${id.slice(0, 8)}…`
}

function mimeFromPathAndType(
  mediaPath: string,
  mediaType: DecryptedMessage['media_type']
): string {
  const p = mediaPath.toLowerCase()
  if (p.endsWith('.webm')) {
    return mediaType === 'audio' ? 'audio/webm' : 'video/webm'
  }
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.mp4')) return 'video/mp4'
  if (mediaType === 'audio') return 'audio/webm'
  if (mediaType === 'video') return 'video/webm'
  if (mediaType === 'image') return 'image/jpeg'
  return 'application/octet-stream'
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
  cryptoCtx,
  sendText,
  sendMedia,
  composeDisabled = false,
}: {
  userId: string
  sharedKey: CryptoKey | null
  currentUsername: string
  activeChat: ApiChatRow | null
  directPeerUsername: string | null
  senderRoles?: Record<string, ChatMemberRole>
  myAvatarKey?: string | null
  peerAvatarKey?: string | null
  cryptoCtx: ChatCryptoContext | null
  sendText: (
    t: string,
    replyToId?: string | null,
    opts?: { burn_at?: string | null }
  ) => Promise<void>
  sendMedia: (
    blob: Blob,
    mediaType: 'audio' | 'video' | 'image' | 'file',
    caption?: string,
    options?: { fileName?: string; fileType?: string }
  ) => Promise<void>
  composeDisabled?: boolean
}) {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const readAtOverrides = useChatStore((s) => s.readAtOverrides)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const ref = useRef<HTMLDivElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
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
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxMedia, setLightboxMedia] = useState<Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }>>([])
  const [lightboxIndex, setLightboxIndex] = useState(0)

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

  const groupedMessages = useMemo(() => {
    return groupMessages(renderMessages)
  }, [renderMessages])

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
    if (!ctxMenu) return
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ctxMenu])

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

  function replySnippet(msg: DecryptedMessage): string {
    const env = parseAttachmentEnvelope(msg.plaintext)
    if (env) return env.fileName.length > 48 ? `${env.fileName.slice(0, 48)}…` : env.fileName
    if (msg.plaintext && msg.plaintext !== '[DECRYPT_FAIL]') {
      return msg.plaintext.length > 60 ? `${msg.plaintext.slice(0, 60)}…` : msg.plaintext
    }
    if (msg.media_path) return '[MEDIA]'
    return '—'
  }

  const handleMediaClick = (media: { id: string; url: string; type: 'image' | 'video'; mimeType: string }) => {
    const allMedia: Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }> = []

    for (const group of groupedMessages) {
      if (group.type === 'UNIT') {
        const msg = group.message
        if (msg.media_path && msg.media_iv && msg.media_type) {
          const mime = mimeFromPathAndType(msg.media_path, msg.media_type)
          if (msg.media_type === 'image' || msg.media_type === 'video') {
            allMedia.push({
              id: msg.id,
              url: '',
              type: msg.media_type as 'image' | 'video',
              mimeType: mime,
            })
          }
        }
      } else {
        for (const msg of group.messages) {
          if (msg.media_path && msg.media_iv && msg.media_type) {
            const mime = mimeFromPathAndType(msg.media_path, msg.media_type)
            if (msg.media_type === 'image' || msg.media_type === 'video') {
              allMedia.push({
                id: msg.id,
                url: '',
                type: msg.media_type as 'image' | 'video',
                mimeType: mime,
              })
            }
          }
        }
      }
    }

    const currentIndex = allMedia.findIndex(m => m.id === media.id)
    if (currentIndex !== -1) {
      allMedia[currentIndex] = media
      setLightboxMedia(allMedia)
      setLightboxIndex(currentIndex)
      setLightboxOpen(true)
    }
  }

  const handleLightboxNavigate = (index: number) => {
    setLightboxIndex(index)
  }

  const handleLightboxClose = () => {
    setLightboxOpen(false)
    setLightboxMedia([])
    setLightboxIndex(0)
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
        void getOlderCachedMessages(activeChatId, OLDER_PAGE_SIZE + olderMessages.length)
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
            {t('chat.emptyTitle')}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-red-900">
            {t('chat.emptySubtitle')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="crt-terminal-vignette relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
      {ctxMenu ? (
        <div
          ref={ctxMenuRef}
          className="fixed z-[120] min-w-[11rem] border border-neon-cyan/80 bg-black py-1 shadow-[0_0_20px_rgba(0,255,255,0.12)]"
          role="menu"
          aria-label={t('chat.contextMenuAria')}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
            onClick={(e) => {
              e.stopPropagation()
              setReplyTo(ctxMenu.msg)
              setCtxMenu(null)
            }}
          >
            [ {t('chat.contextReply')} ]
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-red-800 hover:bg-neon-red/10"
            onClick={(e) => {
              e.stopPropagation()
              removeMessage(ctxMenu.msg.id)
              void deleteCachedMessage(ctxMenu.msg.id)
              setCtxMenu(null)
            }}
          >
            [ {t('chat.contextDeleteMe')} ]
          </button>
          {ctxMenu.isMine ? (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-neon-red hover:bg-neon-red/15"
              onClick={(e) => {
                e.stopPropagation()
                const id = ctxMenu.msg.id
                setCtxMenu(null)
                void (async () => {
                  try {
                    await deleteMessage(id, true)
                    removeMessage(id)
                    await deleteCachedMessage(id)
                  } catch {
                    /* Server rejected */
                  }
                })()
              }}
            >
              [ {t('chat.contextDeleteEveryone')} ]
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={ref}
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain px-4 py-3 font-mono text-sm text-neon-red [-webkit-overflow-scrolling:touch]"
      >
        <div ref={topSentinelRef} className="h-1 w-full" aria-hidden />
        {renderMessages.length === 0 ? (
          <div className="flex h-full min-h-[12rem] items-center justify-center">
            <div className="space-y-2 border border-neon-cyan/20 px-6 py-4 text-center">
              <p className="font-mono text-xs tracking-[0.25em] text-neon-cyan/50">
                {t('chat.noLogsTitle')}
              </p>
              <p className="text-[9px] uppercase tracking-widest text-red-900">
                {t('chat.noLogsHint')}
              </p>
            </div>
          </div>
        ) : null}
        {groupedMessages.map((group, groupIndex) => {
          if (group.type === 'UNIT') {
            const m = group.message
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
                  const pad = 8
                  const mw = 200
                  const mh = 120
                  const x = Math.min(
                    e.clientX,
                    (typeof window !== 'undefined' ? window.innerWidth : e.clientX) - mw - pad
                  )
                  const y = Math.min(
                    e.clientY,
                    (typeof window !== 'undefined' ? window.innerHeight : e.clientY) - mh - pad
                  )
                  setCtxMenu({
                    msg: m,
                    x: Math.max(pad, x),
                    y: Math.max(pad, y),
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
                        {replySnippet(replyMsg)}
                      </div>
                    ) : m.reply_to_id ? (
                      <div className="mb-1 text-[10px] text-red-900">
                        ↳ [{t('chat.originalDeleted')}]
                      </div>
                    ) : null}
                    <div className="mb-1 text-[9px] text-red-800/90">
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                    {m.plaintext && !parseAttachmentEnvelope(m.plaintext) ? (
                      <NoirPlaintext
                        text={m.plaintext}
                        className="whitespace-pre-wrap break-words"
                      />
                    ) : null}
                    {m.media_path && m.media_iv && m.media_type ? (
                      <MediaMessage
                        message={m}
                        sharedKey={sharedKey}
                        onMediaClick={handleMediaClick}
                      />
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
          } else if (group.type === 'COLLECTION') {
            // Grouped media messages
            const mine = group.originId === userId
            const senderLabel = labelForSender(group.originId)
            const gridCols = group.messages.length === 1 ? 1 :
                           group.messages.length === 2 ? 2 : 3
            const gridRows = Math.ceil(group.messages.length / gridCols)

            return (
              <div
                key={`group-${groupIndex}`}
                className={`group mb-3 flex w-full ${mine ? 'justify-end' : 'justify-start'}`}
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
                        userId={group.originId}
                        username={labelForSender(group.originId)}
                        avatarKey={avatarKeyForSender(group.originId)}
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
                    {roleGlyph(group.originId)}
                    <span>{senderLabel}</span>
                  </div>
                  <div
                    className={`w-full rounded-none border px-3 py-2 ${
                      mine
                        ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                        : 'border-neon-cyan/25 bg-black/80 text-neon-red'
                    }`}
                  >
                    <div className="mb-1 text-[9px] text-red-800/90">
                      {group.timestamp.toLocaleString()}
                    </div>
                    <div
                      className={`grid gap-1 ${
                        gridCols === 1 ? 'grid-cols-1' :
                        gridCols === 2 ? 'grid-cols-2' :
                        'grid-cols-3'
                      }`}
                      style={{
                        aspectRatio: gridCols === 1 ? '4/3' :
                                   gridCols === 2 ? '2/1' :
                                   gridRows === 1 ? '3/1' : '1/1'
                      }}
                    >
                      {group.messages.map((m) => (
                        <div key={m.id} className="relative">
                          {m.media_path && m.media_iv && m.media_type ? (
                            <MediaMessage
                              message={m}
                              sharedKey={sharedKey}
                              onMediaClick={handleMediaClick}
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          }
        })}
        <div ref={bottomRef} className="h-px w-full shrink-0" aria-hidden />
      </div>

      {/* ONLY THE UNIFIED CHAT INPUT REMAINS */}
      <div className="shrink-0 bg-black">
        <ChatInput
          sendText={sendText}
          sendMedia={sendMedia}
          cryptoCtx={cryptoCtx}
          disabled={composeDisabled}
        />
      </div>

      <MediaLightbox
        isOpen={lightboxOpen}
        media={lightboxMedia}
        currentIndex={lightboxIndex}
        onClose={handleLightboxClose}
        onNavigate={handleLightboxNavigate}
      />
    </div>
  )
}
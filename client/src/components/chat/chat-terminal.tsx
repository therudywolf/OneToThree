'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Crown, Star, ArrowDown, Reply } from 'lucide-react'
import { useVirtualizer as _useVirtualizer } from '@tanstack/react-virtual'
import { useChatStore } from '@/store/chatStore'
import { getFmSocket } from '@/lib/api/socket'
import { MediaMessage } from '@/components/chat/media-message'
import { ChatInput } from '@/components/chat/chat-input'
import { parseAttachmentEnvelope } from '@/lib/attachment-envelope'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { deleteMessage } from '@/lib/api/chats'
import {
  deleteCachedMessage,
  getOlderCachedMessages,
} from '@/lib/message-cache'
import { decryptBinary, base64ToArrayBuffer, importAesGcm256RawKey } from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'
import { getCachedMedia, setCachedMedia } from '@/lib/media-cache'
import { lookupUsers } from '@/lib/api/users'
import { NoirPlaintext } from '@/components/chat/noir-plaintext'
import { CollapsibleText } from '@/components/chat/collapsible-text'
import { MessageStatus } from '@/components/chat/message-status'
import { MessageReactions } from '@/components/chat/message-reactions'
import { MessageActions, QuickReactBar } from '@/components/chat/message-actions'
import { UserAvatar } from '@/components/user-avatar'
import { createDirectE2EChat, fetchChatsList, type ApiChatRow, type ChatMemberRole } from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'
import { useReadReceipts } from '@/hooks/use-read-receipts'
import { useTranslation } from '@/hooks/use-translation'
import type { DecryptedMessage } from '@/types/chat'
import { MediaLightbox } from '@/components/chat/media-lightbox'
import { UserProfileModal } from '@/components/chat/user-profile-modal'
import { groupMessages } from '@/lib/message-grouping'
import { MessageSkeleton } from '@/components/ui/skeleton'
import { formatMessageTimestamp } from '@/lib/timestamp-format'

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
  const { t, module: locale } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const historyDecryptBusy = useChatStore((s) => s.historyDecryptBusy)
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
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)
  const [reactingMsgId, setReactingMsgId] = useState<string | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [newMsgCount, setNewMsgCount] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxMedia, setLightboxMedia] = useState<Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }>>([])
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const lightboxMetaRef = useRef<Map<string, { mediaPath: string; mediaIv: string; plaintext?: string }>>(new Map())
  const [profileTarget, setProfileTarget] = useState<{
    userId: string
    username: string
    avatarKey?: string | null
  } | null>(null)
  const [isNearBottom, setIsNearBottom] = useState(true)
  // Keep a ref in sync so effects reading it don't go stale
  const isNearBottomRef = useRef(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)
  const prevMsgCountRef = useRef(0)
  const swipeRef = useRef<{ startX: number; msgId: string } | null>(null)
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const prevScrollHeightRef = useRef(0)

  const isGroup = activeChat?.is_group ?? false
  const isSelfChat = !isGroup && activeChat != null && activeChat.member_ids.length === 1 && activeChat.member_ids[0] === userId

  useReadReceipts(ref, { enabled: !isGroup })

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    isNearBottomRef.current = near
    setIsNearBottom(near)
    if (near) setHasNewBelow(false)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    const diff = messages.length - prevMsgCountRef.current
    if (diff > 0 && !isNearBottomRef.current) {
      setHasNewBelow(true)
      setNewMsgCount((prev) => prev + diff)
    }
    if (isNearBottomRef.current) {
      setNewMsgCount(0)
    }
    prevMsgCountRef.current = messages.length
  }, [messages.length])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    setHasNewBelow(false)
    setNewMsgCount(0)
  }, [])

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

  // Scroll to bottom when switching chats
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [activeChatId])

  // Scroll to bottom when new messages arrive and user is already near bottom.
  // Uses a ref so this effect never goes stale — no re-registration on every scroll.
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [messages.length])

  useEffect(() => {
    setOlderMessages([])
    setHasMoreOlder(true)
    setLoadingOlder(false)
  }, [activeChatId])

  const handleMessageAction = useCallback(
    (action: string, msg: DecryptedMessage) => {
      const mine = msg.sender_id === userId
      switch (action) {
        case 'reply':
          setReplyTo(msg)
          break
        case 'copy':
          if (msg.plaintext) {
            void navigator.clipboard.writeText(msg.plaintext)
          }
          break
        case 'deleteForMe':
          removeMessage(msg.id)
          void deleteCachedMessage(msg.id)
          break
        case 'deleteForAll':
          if (mine) {
            void (async () => {
              try {
                await deleteMessage(msg.id, true)
                removeMessage(msg.id)
                await deleteCachedMessage(msg.id)
              } catch {
                /* Server rejected */
              }
            })()
          }
          break
        case 'react':
          setReactingMsgId(msg.id)
          break
      }
    },
    [userId, setReplyTo, removeMessage],
  )

  const handleToggleReaction = useCallback(
    (emoji: string, msgId: string) => {
      if (!activeChat?.id) return
      getFmSocket().send({
        type: 'toggle_reaction',
        message_id: msgId,
        chat_id: activeChat.id,
        emoji,
      })
    },
    [activeChat?.id],
  )

  // Long-press for mobile context menu
  const handleTouchStart = useCallback(
    (msg: DecryptedMessage, e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      longPressRef.current = setTimeout(() => {
        const mine = msg.sender_id === userId
        setCtxMenu({
          msg,
          x: touch.clientX,
          y: touch.clientY,
          isMine: mine,
        })
      }, 500)
    },
    [userId],
  )

  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  // Swipe-to-reply handlers (mobile)
  const handleSwipeStart = useCallback((msgId: string, e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    swipeRef.current = { startX: touch.clientX, msgId }
  }, [])

  const handleSwipeMove = useCallback((e: React.TouchEvent) => {
    if (!swipeRef.current) return
    const touch = e.touches[0]
    if (!touch) return
    const dx = touch.clientX - swipeRef.current.startX
    if (dx > 0) {
      setSwipingMsgId(swipeRef.current.msgId)
      setSwipeOffset(Math.min(dx, 80))
    }
  }, [])

  const handleSwipeEnd = useCallback(() => {
    if (swipeRef.current && swipeOffset > 50) {
      const msg = renderMessages.find((m) => m.id === swipeRef.current!.msgId)
      if (msg) setReplyTo(msg)
    }
    swipeRef.current = null
    setSwipingMsgId(null)
    setSwipeOffset(0)
  }, [swipeOffset, renderMessages, setReplyTo])

  // Context menu close is handled by MessageActions component internally

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

  // Voice message IDs for prev/next navigation
  const voiceMessageIds = useMemo(() => {
    return renderMessages
      .filter((m) => m.media_type === 'audio' && m.media_path && m.media_iv)
      .map((m) => m.id)
  }, [renderMessages])

  const scrollToAndPlayVoice = useCallback((targetId: string) => {
    const el = ref.current?.querySelector(`[data-message-id="${targetId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Trigger play on the audio element inside
      setTimeout(() => {
        const audio = el.querySelector('audio') as HTMLAudioElement | null
        if (audio) void audio.play()
      }, 400)
    }
  }, [])

  const navigateVoice = useCallback((currentId: string, direction: 'prev' | 'next') => {
    const idx = voiceMessageIds.indexOf(currentId)
    if (idx === -1) return
    const targetIdx = direction === 'prev' ? idx - 1 : idx + 1
    const targetId = voiceMessageIds[targetIdx]
    if (targetId) scrollToAndPlayVoice(targetId)
  }, [voiceMessageIds, scrollToAndPlayVoice])

  const handleMediaClick = (media: { id: string; url: string; type: 'image' | 'video'; mimeType: string }) => {
    const allMedia: Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }> = []
    const metaMap = new Map<string, { mediaPath: string; mediaIv: string; plaintext?: string }>()

    const collectMsg = (msg: DecryptedMessage) => {
      if (msg.media_path && msg.media_iv && msg.media_type) {
        const mime = mimeFromPathAndType(msg.media_path, msg.media_type)
        if (msg.media_type === 'image' || msg.media_type === 'video') {
          allMedia.push({
            id: msg.id,
            url: '',
            type: msg.media_type as 'image' | 'video',
            mimeType: mime,
          })
          metaMap.set(msg.id, {
            mediaPath: msg.media_path,
            mediaIv: msg.media_iv,
            plaintext: msg.plaintext ?? undefined,
          })
        }
      }
    }

    for (const group of groupedMessages) {
      if (group.type === 'UNIT') {
        collectMsg(group.message)
      } else {
        for (const msg of group.messages) collectMsg(msg)
      }
    }

    const currentIndex = allMedia.findIndex(m => m.id === media.id)
    if (currentIndex !== -1) {
      allMedia[currentIndex] = media
      lightboxMetaRef.current = metaMap
      setLightboxMedia(allMedia)
      setLightboxIndex(currentIndex)
      setLightboxOpen(true)
    }
  }

  const handleLightboxLoadMedia = useCallback(async (index: number): Promise<string | null> => {
    const items = lightboxMedia
    const item = items[index]
    if (!item || item.url) return item?.url ?? null
    const meta = lightboxMetaRef.current.get(item.id)
    if (!meta) return null

    try {
      const cached = await getCachedMedia(item.id)
      if (cached?.blob) {
        const url = URL.createObjectURL(cached.blob)
        setLightboxMedia(prev => {
          const next = [...prev]
          next[index] = { ...next[index], url }
          return next
        })
        return url
      }

      const downloadUrl = await getDownloadUrl(meta.mediaPath)
      const res = await fetch(downloadUrl)
      if (!res.ok) return null

      let plain: ArrayBuffer
      const isPublicMedia = meta.mediaIv === 'public'
      const envelope = meta.plaintext ? parseAttachmentEnvelope(meta.plaintext) : null

      if (isPublicMedia) {
        plain = await res.arrayBuffer()
      } else if (!sharedKey) {
        return null
      } else {
        const cipher = await res.arrayBuffer()
        if (envelope) {
          const wrapPlain = await decryptBinary(
            sharedKey,
            base64ToArrayBuffer(envelope.wrapCt),
            envelope.wrapIv
          )
          const fileKey = await importAesGcm256RawKey(wrapPlain, ['decrypt'])
          const fileIv = new Uint8Array(base64ToArrayBuffer(meta.mediaIv))
          plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fileIv as BufferSource },
            fileKey,
            cipher as BufferSource
          )
        } else {
          plain = await decryptBinary(sharedKey, cipher, meta.mediaIv)
        }
      }

      const mime = envelope?.mimeType ?? item.mimeType
      const blob = new Blob([plain], { type: mime })
      await setCachedMedia(item.id, blob, mime)
      const url = URL.createObjectURL(blob)
      setLightboxMedia(prev => {
        const next = [...prev]
        next[index] = { ...next[index], url }
        return next
      })
      return url
    } catch {
      return null
    }
  }, [lightboxMedia, sharedKey])

  const handleLightboxNavigate = (index: number) => {
    setLightboxIndex(index)
  }

  const handleLightboxClose = () => {
    setLightboxOpen(false)
    setLightboxMedia([])
    setLightboxIndex(0)
    lightboxMetaRef.current.clear()
  }

  function openProfile(senderId: string) {
    setProfileTarget({
      userId: senderId,
      username: labelForSender(senderId),
      avatarKey: avatarKeyForSender(senderId),
    })
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
        const scrollEl = ref.current
        if (scrollEl) prevScrollHeightRef.current = scrollEl.scrollHeight
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
            // Preserve scroll position after older messages are inserted
            requestAnimationFrame(() => {
              if (scrollEl) {
                const newHeight = scrollEl.scrollHeight
                scrollEl.scrollTop += newHeight - prevScrollHeightRef.current
              }
            })
          })
          .finally(() => setLoadingOlder(false))
      },
      { root: ref.current, threshold: 0.05 }
    )
    io.observe(topSentinelRef.current)
    return () => io.disconnect()
  }, [activeChatId, hasMoreOlder, loadingOlder, oldestLoaded, olderMessages.length])

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
        <MessageActions
          message={ctxMenu.msg}
          isMine={ctxMenu.isMine}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onAction={(action) => handleMessageAction(action, ctxMenu.msg)}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
      <div
        ref={ref}
        className="chat-scroll min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain px-2 py-3 font-mono text-sm text-neon-red [-webkit-overflow-scrolling:touch] sm:px-4"
        onClick={() => { if (reactingMsgId) setReactingMsgId(null) }}
      >
        <div ref={topSentinelRef} className="h-1 w-full" aria-hidden />
        {loadingOlder ? (
          <div className="flex items-center justify-center py-2">
            <span className="animate-pulse font-mono text-[9px] uppercase tracking-widest text-neon-cyan/50">
              {t('common.loading')}
            </span>
          </div>
        ) : null}
        {historyDecryptBusy && renderMessages.length === 0 ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 6 }, (_, i) => (
              <MessageSkeleton key={i} align={i % 2 === 0 ? 'left' : 'right'} />
            ))}
          </div>
        ) : renderMessages.length === 0 ? (
          <div className="flex h-full min-h-[12rem] items-center justify-center">
            <div className="space-y-3 border border-neon-cyan/20 px-6 py-4 text-center">
              {isSelfChat ? (
                <p className="font-mono text-xs tracking-[0.25em] text-amber-400">
                  {t('sidebar.savedMessages')}
                </p>
              ) : !isGroup && directPeerUsername ? (
                <>
                  <UserAvatar
                    userId={activeChat?.member_ids.find((id) => id !== userId) ?? ''}
                    username={directPeerUsername}
                    avatarKey={null}
                    size={48}
                  />
                  <p className="font-mono text-xs tracking-[0.25em] text-neon-cyan/60">
                    {directPeerUsername}
                  </p>
                </>
              ) : isGroup ? (
                <p className="font-mono text-xs tracking-[0.25em] text-neon-cyan/60">
                  {activeChat?.name || t('sidebar.groupUntitled')}
                </p>
              ) : null}
              <p className="font-mono text-xs tracking-[0.25em] text-neon-cyan/50">
                {t('chat.noLogsTitle')}
              </p>
              <p className="text-[9px] uppercase tracking-widest text-red-900">
                {isGroup ? t('chat.emptyGroupHint') : t('chat.noLogsHint')}
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
                className={`group/msg relative mb-3 flex w-full ${mine ? 'justify-end' : 'justify-start'} transition-transform duration-150`}
                style={{
                  transform: swipingMsgId === m.id ? `translateX(${swipeOffset}px)` : undefined,
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const pad = 8
                  const mw = 200
                  const mh = 320
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
                onMouseEnter={() => setHoveredMsgId(m.id)}
                onMouseLeave={() => setHoveredMsgId(null)}
                onTouchStart={(e) => {
                  handleTouchStart(m, e)
                  handleSwipeStart(m.id, e)
                }}
                onTouchMove={handleSwipeMove}
                onTouchEnd={() => {
                  handleTouchEnd()
                  handleSwipeEnd()
                }}
                onTouchCancel={() => {
                  handleTouchEnd()
                  handleSwipeEnd()
                }}
              >
                {/* Swipe-to-reply indicator (mobile) */}
                {swipingMsgId === m.id && swipeOffset > 10 ? (
                  <div
                    className="absolute left-0 top-1/2 z-10 -translate-x-full -translate-y-1/2 flex items-center justify-center md:hidden"
                    style={{ opacity: Math.min(1, swipeOffset / 50) }}
                  >
                    <Reply className="h-4 w-4 text-neon-cyan" />
                  </div>
                ) : null}
                <div
                  className={`msg-bubble-width min-w-0 relative ${
                    mine ? 'items-end' : 'items-start'
                  } flex flex-col gap-1`}
                >
                  {/* Hover quick-react bar (desktop only) — positioned relative to bubble */}
                  {hoveredMsgId === m.id ? (
                    <div className={`absolute -top-8 z-10 hidden md:block ${mine ? 'right-0' : 'left-0'}`}>
                      <QuickReactBar onReact={(emoji) => handleToggleReaction(emoji, m.id)} />
                    </div>
                  ) : null}
                  <div
                    className={`flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-widest ${
                      mine
                        ? 'flex-row-reverse justify-end text-right text-neon-cyan/70'
                        : 'justify-start text-left text-neon-cyan/80'
                    }`}
                  >
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); openProfile(m.sender_id) }}
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
                    </button>
                    {roleGlyph(m.sender_id)}
                    <button
                      type="button"
                      className="cursor-pointer hover:text-neon-red transition-colors"
                      onClick={(e) => { e.stopPropagation(); openProfile(m.sender_id) }}
                    >
                      {senderLabel}
                    </button>
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
                      {formatMessageTimestamp(m.created_at, locale)}
                    </div>
                    {m.plaintext && !parseAttachmentEnvelope(m.plaintext) ? (
                      <CollapsibleText text={m.plaintext}>
                        {(visibleText) => (
                          <NoirPlaintext
                            text={visibleText}
                            className="whitespace-pre-wrap break-words"
                          />
                        )}
                      </CollapsibleText>
                    ) : null}
                    {m.media_path && m.media_iv && m.media_type ? (
                      <MediaMessage
                        message={m}
                        sharedKey={sharedKey}
                        onMediaClick={handleMediaClick}
                        onAudioEnd={() => navigateVoice(m.id, 'next')}
                        onPrevVoice={voiceMessageIds.indexOf(m.id) > 0 ? () => navigateVoice(m.id, 'prev') : undefined}
                        onNextVoice={voiceMessageIds.indexOf(m.id) < voiceMessageIds.length - 1 ? () => navigateVoice(m.id, 'next') : undefined}
                      />
                    ) : null}
                    {m.reactions && Object.keys(m.reactions).length > 0 ? (
                      <MessageReactions
                        reactions={m.reactions}
                        currentUserId={userId}
                        onToggleReaction={(emoji) => handleToggleReaction(emoji, m.id)}
                        onOpenPicker={() => {}}
                      />
                    ) : null}
                    {reactingMsgId === m.id ? (
                      <div className="mt-1">
                        <QuickReactBar onReact={(emoji) => { handleToggleReaction(emoji, m.id); setReactingMsgId(null) }} />
                      </div>
                    ) : null}
                    {mine ? (
                      <div
                        className="mt-1 flex items-center justify-end gap-0.5 text-[10px]"
                        aria-hidden
                      >
                        <MessageStatus
                          pending={m._pending}
                          readAt={m.read_at}
                        />
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
                  className={`msg-bubble-width min-w-0 ${
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
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); openProfile(group.originId) }}
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
                    </button>
                    {roleGlyph(group.originId)}
                    <button
                      type="button"
                      className="cursor-pointer hover:text-neon-red transition-colors"
                      onClick={(e) => { e.stopPropagation(); openProfile(group.originId) }}
                    >
                      {senderLabel}
                    </button>
                  </div>
                  <div
                    className={`w-full rounded-none border px-3 py-2 ${
                      mine
                        ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                        : 'border-neon-cyan/25 bg-black/80 text-neon-red'
                    }`}
                  >
                    <div className="mb-1 text-[9px] text-red-800/90">
                      {formatMessageTimestamp(group.timestamp.toISOString(), locale)}
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
                        <div key={m.id} data-message-id={m.id} className="relative">
                          {m.media_path && m.media_iv && m.media_type ? (
                            <MediaMessage
                              message={m}
                              sharedKey={sharedKey}
                              onMediaClick={handleMediaClick}
                              onAudioEnd={() => navigateVoice(m.id, 'next')}
                              onPrevVoice={voiceMessageIds.indexOf(m.id) > 0 ? () => navigateVoice(m.id, 'prev') : undefined}
                              onNextVoice={voiceMessageIds.indexOf(m.id) < voiceMessageIds.length - 1 ? () => navigateVoice(m.id, 'next') : undefined}
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

      {hasNewBelow ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 border border-neon-cyan/60 bg-black/90 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan shadow-[0_0_12px_rgba(0,255,255,0.15)] transition-colors hover:bg-neon-cyan/10"
        >
          <ArrowDown className="h-3 w-3" />
          {newMsgCount > 0
            ? `\u2193 ${newMsgCount} ${t('msg.newMessages')}`
            : t('chat.scrollToBottom')}
        </button>
      ) : null}

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
        onLoadMedia={handleLightboxLoadMedia}
      />

      {profileTarget ? (
        <UserProfileModal
          userId={profileTarget.userId}
          username={profileTarget.username}
          avatarKey={profileTarget.avatarKey}
          onClose={() => setProfileTarget(null)}
          onMessage={async () => {
            try {
              const chats = await fetchChatsList()
              const existing = chats.find(
                c => !c.is_group && c.member_ids.some(id => canonicalUserId(id) === canonicalUserId(profileTarget.userId))
              )
              if (existing) {
                useChatStore.getState().setActiveChatId(existing.id)
              } else {
                const chat = await createDirectE2EChat(userId, profileTarget.userId)
                useChatStore.getState().setActiveChatId(chat.id)
              }
            } catch (err) {
              console.error('[SYS.CHAT] Failed to open DM:', err)
            }
          }}
        />
      ) : null}
    </div>
  )
}

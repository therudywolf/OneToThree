'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Crown, Star, ArrowDown, Reply, SmilePlus, MoreHorizontal, Lock } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'
import { getFmSocket } from '@/lib/api/socket'
import { MediaMessage } from '@/components/chat/media-message'
import { ChatInput } from '@/components/chat/chat-input'
import { parseAttachmentEnvelope, parseStickerEnvelope } from '@/lib/attachment-envelope'
import { StickerBubble } from '@/components/chat/sticker-bubble'
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
import { formatMessageTimestamp, formatDateDivider, calendarDayKey } from '@/lib/timestamp-format'
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'
import { ForwardModal } from '@/components/chat/forward-modal'
import { ThreadPanel } from '@/components/chat/thread-panel'
import { cloneStickerPack } from '@/lib/api/stickers'
import { addGifFavorite, type GifHit } from '@/lib/api/gif'
import { toastError, toastSuccess } from '@/store/toastStore'
import { TELEGRAM_BEHAVIOR } from '@/components/chat/telegram-behavior'

const OLDER_PAGE_SIZE = 25
const OLDER_RAM_CAP = 200

function shortId(id: string) {
  return `${id.slice(0, 8)}…`
}

function gifIdFromUrl(url: string): string {
  return `gif-${encodeURIComponent(url).slice(0, 110)}`
}

function gifFromMessage(msg: DecryptedMessage): GifHit | null {
  const media = msg.media_path?.trim()
  if (media && media.toLowerCase().endsWith('.gif')) {
    return {
      id: gifIdFromUrl(media),
      title: 'gif',
      previewUrl: media,
      originalUrl: media,
    }
  }
  const plain = msg.plaintext?.trim() ?? ''
  const match = plain.match(/https?:\/\/\S+\.gif(\?\S+)?/i)
  if (match?.[0]) {
    const url = match[0]
    return {
      id: gifIdFromUrl(url),
      title: 'gif',
      previewUrl: url,
      originalUrl: url,
    }
  }
  return null
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
  sendAlbum,
  composeDisabled = false,
  typingLabel = null,
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
    options?: { fileName?: string; fileType?: string; kind?: import('@/lib/attachment-envelope').AttachmentKind }
  ) => Promise<void>
  sendAlbum?: (
    items: Array<{
      blob: Blob
      segmentClass: 'audio' | 'video' | 'image' | 'file'
      options?: { label?: string; mime?: string; kind?: import('@/lib/attachment-envelope').AttachmentKind }
    }>,
    caption?: string
  ) => Promise<void>
  composeDisabled?: boolean
  /** Who is currently typing (if any). Rendered as floating overlay above chat scroll area. */
  typingLabel?: string | null
}) {
  const { t, module: locale } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const historyDecryptBusy = useUnreadStore((s) => s.historyDecryptBusy)
  const readAtOverrides = useUnreadStore((s) => s.readAtOverrides)
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
  const [reactingMsgId, setReactingMsgId] = useState<string | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [newMsgCount, setNewMsgCount] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxMedia, setLightboxMedia] = useState<Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }>>([])
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const lightboxMetaRef = useRef<Map<string, { mediaPath: string; mediaIv: string; plaintext?: string }>>(new Map())
  const lightboxMediaRef = useRef<typeof lightboxMedia>([])
  useEffect(() => {
    lightboxMediaRef.current = lightboxMedia
  }, [lightboxMedia])
  useEffect(() => {
    return () => {
      for (const item of lightboxMediaRef.current) {
        if (item.url && item.url.startsWith('blob:')) {
          try { URL.revokeObjectURL(item.url) } catch { /* noop */ }
        }
      }
    }
  }, [])
  const [profileTarget, setProfileTarget] = useState<{
    userId: string
    username: string
    avatarKey?: string | null
  } | null>(null)
  const isNearBottomRef = useRef(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)
  // NOTE: we intentionally do NOT drive auto-scroll by `messages.length` —
  // the chat store is a ring buffer capped at RAM_CACHE_LIMIT (50). Once
  // the cap is hit, the length stays constant even as new messages arrive
  // (the oldest is evicted on every append), so a length-based diff would
  // silently stop autoscrolling after the 50th message. We track identity
  // of the tail instead (id + created_at) which changes on every real
  // arrival.
  const lastMsgKeyRef = useRef<string | null>(null)
  const firstMessagesRenderRef = useRef(true)
  const swipeRef = useRef<{ startX: number; startY: number; msgId: string } | null>(null)
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const prevScrollHeightRef = useRef(0)

  // Forward modal
  const [forwardMsg, setForwardMsg] = useState<DecryptedMessage | null>(null)
  // Thread panel
  const [threadRoot, setThreadRoot] = useState<DecryptedMessage | null>(null)

  const isGroup = activeChat?.is_group ?? false
  const isSelfChat = activeChat != null && isSavedMessagesChat(activeChat, userId)

  useReadReceipts(ref, { enabled: !isGroup })

  // Threshold (in px from the bottom) where we still consider the user
  // "at bottom" and allow auto-scroll to continue.  A loose value (240px)
  // keeps the experience close to Telegram-like: even if someone is browsing
  // the last couple of bubbles, new incoming messages still pull them to the
  // bottom instead of showing the "new messages below" chip.
  const AUTOSCROLL_STICK_PX = TELEGRAM_BEHAVIOR.autoscroll.stickPx

  const scrollToBottomInstant = useCallback(() => {
    const el = ref.current
    if (!el) return
    // Double-RAF: first frame for layout flush (avatars / bubble borders),
    // second frame for late-loading content that mutates height after paint.
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.scrollTop = ref.current.scrollHeight
      requestAnimationFrame(() => {
        if (!ref.current) return
        ref.current.scrollTop = ref.current.scrollHeight
      })
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const near =
      el.scrollHeight - el.scrollTop - el.clientHeight < AUTOSCROLL_STICK_PX
    isNearBottomRef.current = near
    if (near) {
      setHasNewBelow(false)
      setNewMsgCount(0)
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Autoscroll on content growth. Three independent signals feed the same
  // debounced flush:
  //   1. MutationObserver on the scroll container — catches new <MessageRow>
  //      children being mounted (the actual "new message" event).
  //   2. ResizeObserver on *all* direct children — catches a bubble growing
  //      vertically after its image finishes decoding.
  //   3. Bubbled <img>/<video> load / loadedmetadata — the cheapest signal
  //      for late-decoding media on older Safari where the observers lag.
  //
  // In every case we only scroll when the user was already pinned near the
  // bottom — we NEVER override an explicit scroll-up by the user.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let raf = 0
    const flush = () => {
      if (!ref.current) return
      ref.current.scrollTop = ref.current.scrollHeight
    }
    const schedule = () => {
      if (!isNearBottomRef.current) return
      if (raf) cancelAnimationFrame(raf)
      // Double RAF absorbs layout jumps chained off the same frame
      // (bubble mounts → its avatar image decodes one frame later).
      raf = requestAnimationFrame(() => {
        flush()
        raf = requestAnimationFrame(flush)
      })
    }

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(el)
      // Observe every current direct child so media re-layout inside a
      // specific bubble fires the handler even if the container height
      // stays constant.
      Array.from(el.children).forEach((child) => ro!.observe(child))
    }

    // MutationObserver picks up newly appended message rows — unlike
    // ResizeObserver this fires IMMEDIATELY on mount, before media decode.
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node instanceof Element && ro) {
            ro.observe(node)
          }
        })
      }
      schedule()
    })
    mo.observe(el, { childList: true, subtree: false })

    // Late media decode fallback.
    const onMediaLoad = (ev: Event) => {
      const tgt = ev.target as Element | null
      if (!tgt) return
      if (tgt.tagName !== 'IMG' && tgt.tagName !== 'VIDEO') return
      schedule()
    }
    el.addEventListener('load', onMediaLoad, true)
    el.addEventListener('loadedmetadata', onMediaLoad, true)

    return () => {
      ro?.disconnect()
      mo.disconnect()
      el.removeEventListener('load', onMediaLoad, true)
      el.removeEventListener('loadedmetadata', onMediaLoad, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    if (messages.length === 0) {
      lastMsgKeyRef.current = null
      return
    }

    const newest = messages[messages.length - 1]
    // Identity key is (id, created_at) — survives the ring-buffer eviction
    // where length stays constant while the tail rotates.
    const key = `${newest.id}:${newest.created_at}`
    const prevKey = lastMsgKeyRef.current
    lastMsgKeyRef.current = key

    // First render of this chat — useLayoutEffect below already snapped
    // us to the bottom. Don't fight it.
    if (firstMessagesRenderRef.current) {
      firstMessagesRenderRef.current = false
      return
    }

    if (prevKey === key) return // same tail → nothing new

    const sentByMe = newest.sender_id === userId

    if (isNearBottomRef.current || sentByMe) {
      scrollToBottomInstant()
      isNearBottomRef.current = true
      setHasNewBelow(false)
      setNewMsgCount(0)
    } else {
      setHasNewBelow(true)
      setNewMsgCount((prev) => prev + 1)
    }
  }, [messages, userId, scrollToBottomInstant])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
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
    setSenderMeta({})
    if (!senderIdsToResolve.length) return
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

  // Pinned for first-unread anchor. Frozen at the moment the chat opens
  // so that incoming messages don't keep shifting the marker down.
  const [firstUnreadAnchorId, setFirstUnreadAnchorId] = useState<string | null>(null)
  const firstUnreadIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    setOlderMessages([])
    setHasMoreOlder(true)
    setLoadingOlder(false)
    lastMsgKeyRef.current = null
    firstMessagesRenderRef.current = true
    firstUnreadIdRef.current = null
    setFirstUnreadAnchorId(null)
    isNearBottomRef.current = true
    setHasNewBelow(false)
    setNewMsgCount(0)

    // Hide the scroll container for one synchronous paint so we can position
    // without the user seeing a flight-from-middle-to-bottom animation. We
    // flip it back to visible inside a rAF once we've committed a scrollTop.
    const el = ref.current
    if (el) {
      el.setAttribute('data-stabilizing', 'true')
      // Apply snap BEFORE the paint. The second rAF un-hides it after layout.
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        if (!ref.current) return
        ref.current.scrollTop = ref.current.scrollHeight
        requestAnimationFrame(() => {
          if (!ref.current) return
          ref.current.scrollTop = ref.current.scrollHeight
          ref.current.setAttribute('data-stabilizing', 'false')
        })
      })
    } else {
      scrollToBottomInstant()
    }
  }, [activeChatId, scrollToBottomInstant])

  // On first batch of loaded messages for this chat, compute the first-unread
  // anchor (oldest message not read by me) if there is one. This lets us
  // draw an "Unread messages" divider Telegram-style. We freeze the anchor
  // on first real render and don't move it afterwards.
  useEffect(() => {
    if (firstUnreadIdRef.current !== null) return // already anchored
    if (!activeChatId || !userId) return
    if (messages.length === 0) return

    // Scan chronologically for the first peer message the user hasn't read.
    for (const m of messages) {
      if (m.sender_id === userId) continue
      if (m.read_at ?? readAtOverrides[m.id]) continue
      firstUnreadIdRef.current = m.id
      setFirstUnreadAnchorId(m.id)
      break
    }
    // Explicit "no unread" marker so we don't keep scanning.
    if (!firstUnreadIdRef.current) {
      firstUnreadIdRef.current = ''
    }
  }, [messages, activeChatId, readAtOverrides, userId])

  // Keep unread divider in sync: if the anchored unread message becomes read,
  // move anchor to next unread or hide the divider completely.
  useEffect(() => {
    if (!activeChatId || !userId) return
    if (!firstUnreadAnchorId) return
    const anchor = messages.find((m) => m.id === firstUnreadAnchorId)
    if (!anchor) {
      setFirstUnreadAnchorId(null)
      firstUnreadIdRef.current = ''
      return
    }
    if (!(anchor.read_at ?? readAtOverrides[anchor.id])) return
    const nextUnread = messages.find(
      (m) => m.sender_id !== userId && !(m.read_at ?? readAtOverrides[m.id])
    )
    if (!nextUnread) {
      setFirstUnreadAnchorId(null)
      firstUnreadIdRef.current = ''
      return
    }
    setFirstUnreadAnchorId(nextUnread.id)
    firstUnreadIdRef.current = nextUnread.id
  }, [activeChatId, firstUnreadAnchorId, messages, readAtOverrides, userId])

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
          toastSuccess(t('chat.originalDeleted'))
          break
        case 'deleteForAll':
          if (mine) {
            void (async () => {
              try {
                await deleteMessage(msg.id, true)
                removeMessage(msg.id)
                await deleteCachedMessage(msg.id)
                toastSuccess(t('chat.originalDeleted'))
              } catch {
                toastError('DELETE_FOR_ALL_FAILED')
              }
            })()
          }
          break
        case 'react':
          setReactingMsgId(msg.id)
          break
        case 'saveToMine': {
          const stickerEnv = parseStickerEnvelope(msg.plaintext)
          if (stickerEnv) {
            void (async () => {
              try {
                const out = await cloneStickerPack(stickerEnv.packId)
                toastSuccess(
                  out.already_owned ? t('stickers.alreadyMine') : t('stickers.addedMine'),
                  { title: 'Stickers' }
                )
              } catch (err) {
                toastError(err instanceof Error ? err.message : 'STICKER_SAVE_FAILED', { title: 'Stickers' })
              }
            })()
            break
          }
          const gif = gifFromMessage(msg)
          if (!gif) break
          void (async () => {
            try {
              await addGifFavorite(gif)
              toastSuccess(t('gif.addedToFavorites'), { title: 'GIF' })
            } catch (err) {
              toastError(err instanceof Error ? err.message : 'GIF_FAVORITE_ADD_FAILED', { title: 'GIF' })
            }
          })()
          break
        }
        case 'forward':
          setForwardMsg(msg)
          break
        case 'thread':
          setThreadRoot(msg)
          break
        case 'edit':
          // Stage the message for editing via ChatInput's `editingMessage`
          // prop (consumed via the chat store). Keeps the composer generic
          // and lets it decide how to populate the text field.
          useChatStore.setState({ editingMessage: msg })
          break
        case 'pin': {
          // Pin/unpin via REST. The server broadcasts the updated pinned
          // list over WS which the chatStore reduces.
          void (async () => {
            try {
              const { API_URL } = await import('@/lib/api/auth')
              await fetch(`${API_URL}/messages/${msg.id}/pin`, {
                method: 'POST',
                credentials: 'include',
              })
            } catch {
              /* best effort; toast handled by higher level */
            }
          })()
          break
        }
      }
    },
    [userId, setReplyTo, removeMessage],
  )

  // Forward handler: re-encrypts msg.plaintext under the target chat's crypto
  // context and sends it as a normal message. E2E-safe: the server never sees
  // the plaintext and cannot "move" ciphertext between chats because each chat
  // has its own key material. This is purely a client-side operation.
  const privateKeyForForward = useSessionStore((s) => s.unwrappedPrivateKey)
  const handleForward = useCallback(
    async (chatId: string, text: string) => {
      if (!userId) throw new Error('FORWARD_NOT_AUTHED')
      if (!privateKeyForForward) throw new Error('FORWARD_VAULT_LOCKED')
      if (!text.trim()) throw new Error('FORWARD_EMPTY')

      const [{ buildChatCryptoContextWithMeta, encryptOutboundText }, { sendChatMessageOverTransport }] =
        await Promise.all([
          import('@/lib/chat-crypto'),
          import('@/lib/chat-message-transport'),
        ])

      const meta = await buildChatCryptoContextWithMeta(chatId, userId, privateKeyForForward)
      if (!meta) throw new Error('FORWARD_CTX_FAIL')

      const { encrypted_content, iv } = await encryptOutboundText(
        privateKeyForForward,
        text,
        meta.ctx
      )

      await sendChatMessageOverTransport({
        chat_id: chatId,
        transport_mode: meta.ctx.mode,
        plaintext: text,
        sender_private_key: privateKeyForForward,
        my_user_id: userId,
        peer_user_id: meta.peerUserId ?? undefined,
        content: encrypted_content,
        iv,
        reply_to_id: null,
      })
    },
    [userId, privateKeyForForward]
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
      }, TELEGRAM_BEHAVIOR.gestures.longPressMs)
    },
    [userId],
  )

  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  const handleSwipeStart = useCallback((msgId: string, e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    swipeRef.current = { startX: touch.clientX, startY: touch.clientY, msgId }
  }, [])

  const handleSwipeMove = useCallback((e: React.TouchEvent) => {
    if (!swipeRef.current) return
    const touch = e.touches[0]
    if (!touch) return
    const dx = touch.clientX - swipeRef.current.startX
    const dy = Math.abs(touch.clientY - swipeRef.current.startY)
    if (dy > TELEGRAM_BEHAVIOR.gestures.swipeVerticalTolerancePx || Math.abs(dx) > TELEGRAM_BEHAVIOR.gestures.swipeReplyStartPx) {
      handleTouchEnd()
    }
    if (dy > TELEGRAM_BEHAVIOR.gestures.swipeVerticalTolerancePx) {
      setSwipingMsgId(null)
      setSwipeOffset(0)
      return
    }
    if (dx > TELEGRAM_BEHAVIOR.gestures.swipeReplyStartPx) {
      setSwipingMsgId(swipeRef.current.msgId)
      setSwipeOffset(Math.min(dx, TELEGRAM_BEHAVIOR.gestures.swipeReplyMaxPx))
    }
  }, [handleTouchEnd])

  const handleSwipeEnd = useCallback(() => {
    if (swipeRef.current && swipeOffset > TELEGRAM_BEHAVIOR.gestures.swipeReplyCommitPx) {
      const msg = renderMessages.find((m) => m.id === swipeRef.current!.msgId)
      if (msg) setReplyTo(msg)
    }
    swipeRef.current = null
    setSwipingMsgId(null)
    setSwipeOffset(0)
  }, [swipeOffset, renderMessages, setReplyTo])

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
    const st = parseStickerEnvelope(msg.plaintext)
    if (st) return st.fallbackEmoji?.trim() || '🎭'
    if (msg.plaintext && msg.plaintext !== '[DECRYPT_FAIL]') {
      return msg.plaintext.length > 60 ? `${msg.plaintext.slice(0, 60)}…` : msg.plaintext
    }
    if (msg.media_path) return '[MEDIA]'
    return '—'
  }

  const voiceMessageIds = useMemo(() => {
    return renderMessages
      .filter((m) => m.media_type === 'audio' && m.media_path && m.media_iv)
      .map((m) => m.id)
  }, [renderMessages])

  const scrollToAndPlayVoice = useCallback((targetId: string) => {
    const el = ref.current?.querySelector(`[data-message-id="${targetId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
    setLightboxMedia((prev) => {
      for (const item of prev) {
        if (item.url && item.url.startsWith('blob:')) {
          try { URL.revokeObjectURL(item.url) } catch { /* noop */ }
        }
      }
      return []
    })
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
        void getOlderCachedMessages(
          activeChatId,
          { created_at: oldestLoaded.created_at, id: oldestLoaded.id },
          OLDER_PAGE_SIZE
        )
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
  }, [
    activeChatId,
    hasMoreOlder,
    loadingOlder,
    oldestLoaded?.id,
    oldestLoaded?.created_at,
    olderMessages.length,
  ])

  if (!activeChatId) {
    return (
      <div className="crt-terminal-vignette flex flex-1 items-center justify-center bg-void font-mono text-xs text-danger">
        <div className="max-w-xs space-y-3 border border-neon-cyan/20 px-6 py-4 text-center">
          <p className="text-sm tracking-[0.2em] text-neon-cyan/50">
            {t('chat.emptyTitle')}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-danger">
            {t('chat.emptySubtitle')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="crt-terminal-vignette relative flex min-h-0 flex-1 flex-col overflow-hidden bg-void">
      {ctxMenu ? (
        <MessageActions
          message={ctxMenu.msg}
          isMine={ctxMenu.isMine}
          isPinned={ctxMenu.msg.is_pinned === true}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onAction={(action) => handleMessageAction(action, ctxMenu.msg)}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}

      {/* Forward modal */}
      {forwardMsg ? (
        <ForwardModal
          message={forwardMsg}
          onClose={() => setForwardMsg(null)}
          onForward={handleForward}
        />
      ) : null}

      {/* Thread panel — slides in from right */}
      {threadRoot ? (
        <ThreadPanel
          rootMessage={threadRoot}
          allMessages={renderMessages}
          currentUserId={userId}
          onClose={() => setThreadRoot(null)}
          onReply={(msg) => setReplyTo(msg)}
          locale={locale}
          labelForSender={labelForSender}
        />
      ) : null}

      {/* Floating typing indicator — absolutely positioned so it does not
          reflow the message list when it toggles on/off. */}
      {typingLabel ? (
        <div className="p13-typing-indicator" aria-live="polite">
          @{typingLabel}<span className="animate-pulse"> ···</span>
        </div>
      ) : null}
      <div
        ref={ref}
        data-stabilizing="true"
        className="p13-chat-scroll chat-scroll min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain px-2 pb-4 pt-3 text-sm [-webkit-overflow-scrolling:touch] sm:px-4"
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
            <div className="p13-empty-state-box space-y-3">
              {isSelfChat ? (
                <p className="p13-empty-state-text text-accent-2">
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
                  <p className="p13-empty-state-text">{directPeerUsername}</p>
                </>
              ) : isGroup ? (
                <p className="p13-empty-state-text">
                  {activeChat?.name || t('sidebar.groupUntitled')}
                </p>
              ) : null}
              <p className="p13-empty-state-text">{t('chat.noLogsTitle')}</p>
              <p className="p13-empty-state-hint">
                {isGroup ? t('chat.emptyGroupHint') : t('chat.noLogsHint')}
              </p>
            </div>
          </div>
        ) : null}
        {(() => {
          // TG-macOS message grouping pass.
          //
          // Two layers happen here in a single O(n) walk:
          //   1. Calendar day-dividers — injected above the first group
          //      whenever `calendarDayKey(anchor)` changes.
          //   2. Consecutive same-sender run grouping — a group is part of
          //      the "same run" as the previous one iff:
          //        * same sender id
          //        * no date divider separates them
          //        * <= 5min gap from previous group's anchor timestamp
          //      For followups we tighten vertical margin and hide the
          //      avatar+name row, matching TG-macOS / iOS Messages.
          const RUN_WINDOW_MS = 5 * 60 * 1000
          let lastDayKey: string | null = null
          let prevSenderId: string | null = null
          let prevTimestampMs = 0
          return groupedMessages.map((group, groupIndex) => {
          const anchorIso =
            group.type === 'UNIT'
              ? group.message.created_at
              : group.timestamp.toISOString()
          const senderId =
            group.type === 'UNIT' ? group.message.sender_id : group.originId
          const anchorMs = new Date(anchorIso).getTime()
          const dayKey = calendarDayKey(anchorIso)
          const showDateDivider = dayKey !== '' && dayKey !== lastDayKey
          const isRunContinuation =
            !showDateDivider &&
            prevSenderId === senderId &&
            anchorMs - prevTimestampMs <= RUN_WINDOW_MS
          lastDayKey = dayKey
          prevSenderId = senderId
          prevTimestampMs = anchorMs

          const dateDivider = showDateDivider ? (
            <div
              key={`date-${dayKey}`}
              className="p13-date-divider"
              aria-hidden
            >
              <span>{formatDateDivider(anchorIso, locale)}</span>
            </div>
          ) : null

          if (group.type === 'UNIT') {
            const m = group.message
            const replyMsg = m.reply_to_id ? msgById(m.reply_to_id) : null
            const stickerEnv = m.plaintext ? parseStickerEnvelope(m.plaintext) : null
            const mine = m.sender_id === userId
            const senderLabel = labelForSender(m.sender_id)
            const showUnreadDivider =
              !!firstUnreadAnchorId && m.id === firstUnreadAnchorId
            const body = (
              <div
                key={m.id}
                data-message-id={m.id}
                data-sender-id={m.sender_id}
                data-read-at={m.read_at ?? ''}
                data-run-continuation={isRunContinuation ? 'true' : 'false'}
                className={`p13-msg-group group/msg relative flex w-full ${
                  mine ? 'justify-end' : 'justify-start'
                } transition-transform duration-150`}
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
                {swipingMsgId === m.id && swipeOffset > 10 ? (
                  <div
                    className="absolute left-0 top-1/2 z-10 -translate-x-full -translate-y-1/2 flex items-center justify-center md:hidden"
                    style={{ opacity: Math.min(1, swipeOffset / 50) }}
                  >
                    <Reply className="h-4 w-4 text-neon-cyan" />
                  </div>
                ) : null}
                {/* Hover quick-action bar — desktop only, absolute above the bubble */}
                <div className={`p13-hover-actions absolute -top-8 z-10 hidden md:flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 ${
                  mine ? 'right-0' : 'left-0'
                }`}>
                  <button
                    type="button"
                    title={t('msgAction.reply')}
                    aria-label={t('msgAction.reply')}
                    onClick={(e) => { e.stopPropagation(); handleMessageAction('reply', m) }}
                    className="p13-icon-btn h-7 w-7"
                  >
                    <Reply className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    title={t('msgAction.react')}
                    aria-label={t('msgAction.react')}
                    onClick={(e) => { e.stopPropagation(); setReactingMsgId(m.id) }}
                    className="p13-icon-btn h-7 w-7"
                  >
                    <SmilePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    title="More actions"
                    aria-label="More actions"
                    onClick={(e) => {
                      e.stopPropagation()
                      const pad = 8
                      const mw = 200
                      const mh = 320
                      const x = Math.min(e.clientX, (typeof window !== 'undefined' ? window.innerWidth : e.clientX) - mw - pad)
                      const y = Math.min(e.clientY, (typeof window !== 'undefined' ? window.innerHeight : e.clientY) - mh - pad)
                      setCtxMenu({ msg: m, x: Math.max(pad, x), y: Math.max(pad, y), isMine: mine })
                    }}
                    className="p13-icon-btn h-7 w-7"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                </div>
                <div
                  className={`min-w-0 relative ${
                    mine
                      ? 'msg-bubble-width msg-bubble-mine items-end'
                      : 'msg-bubble-peer-width msg-bubble-peer items-start'
                  } p13-msg-stack flex flex-col`}
                >
                  {isRunContinuation ? null : (
                  <div
                    className={`p13-msg-meta p13-label flex items-center gap-2 px-1 text-[11px] ${
                      mine
                        ? 'flex-row-reverse justify-end text-right text-neon-cyan/80'
                        : 'justify-start text-left text-neon-cyan/90'
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
                          size={28}
                        />
                      ) : (
                        <UserAvatar
                          userId={userId}
                          username={currentUsername || 'YOU'}
                          avatarKey={myAvatarKey}
                          size={28}
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
                  )}
                  <div
                    className={`p13-msg-bubble p13-bubble w-full leading-relaxed ${
                      mine ? 'p13-bubble--mine' : 'p13-bubble--peer'
                    }`}
                  >
                    {replyMsg ? (
                      <div
                        className="mb-1 cursor-pointer border-l border-neon-cyan/30 pl-2 text-[10px] text-neon-cyan/60 hover:text-neon-cyan/90"
                        onClick={() => setThreadRoot(replyMsg)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && setThreadRoot(replyMsg)}
                      >
                        <span className="text-danger">
                          ↳ {labelForSender(replyMsg.sender_id)}:
                        </span>{' '}
                        {replySnippet(replyMsg)}
                      </div>
                    ) : m.reply_to_id ? (
                      <div className="mb-1 text-[10px] text-danger">
                        ↳ [{t('chat.originalDeleted')}]
                      </div>
                    ) : null}
                    <div className="p13-label mb-1 text-[10px] opacity-70">
                      {formatMessageTimestamp(m.created_at, locale)}
                    </div>
                    {stickerEnv ? <StickerBubble envelope={stickerEnv} /> : null}
                    {m.plaintext === '[DECRYPT_FAIL]' ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-text-muted/60 text-[11px] italic"
                        title={t('chat.decryptFailed')}
                      >
                        <Lock className="h-3 w-3 shrink-0 text-text-muted/50" aria-hidden />
                        {t('chat.decryptFailed')}
                      </span>
                    ) : m.plaintext && !parseAttachmentEnvelope(m.plaintext) && !stickerEnv ? (
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
            return (
              <div key={m.id} className="contents">
                {dateDivider}
                {showUnreadDivider ? (
                  <div className="chat-unread-divider">
                    {t('chat.unreadMessages') || 'UNREAD MESSAGES'}
                  </div>
                ) : null}
                {body}
              </div>
            )
          } else if (group.type === 'COLLECTION') {
            const mine = group.originId === userId
            const senderLabel = labelForSender(group.originId)
            const gridCols = group.messages.length === 1 ? 1 :
                           group.messages.length === 2 ? 2 : 3
            const gridRows = Math.ceil(group.messages.length / gridCols)

            return (
              <div key={`group-${groupIndex}`} className="contents">
                {dateDivider}
              <div
                data-run-continuation={isRunContinuation ? 'true' : 'false'}
                className={`p13-msg-group group flex w-full ${mine ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`min-w-0 ${
                    mine
                      ? 'msg-bubble-width msg-bubble-mine items-end'
                      : 'msg-bubble-peer-width msg-bubble-peer items-start'
                  } p13-msg-stack flex flex-col`}
                >
                  {isRunContinuation ? null : (
                  <div
                    className={`p13-msg-meta p13-label flex items-center gap-1.5 px-1 text-[10px] ${
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
                  )}
                  <div
                    className={`p13-msg-bubble p13-bubble w-full ${
                      mine ? 'p13-bubble--mine' : 'p13-bubble--peer'
                    }`}
                  >
                    <div className="p13-label mb-1 text-[9px] opacity-70">
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
              </div>
            )
          }
        })
        })()}
        <div ref={bottomRef} className="h-px w-full shrink-0" aria-hidden />
      </div>

      {hasNewBelow ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 inline-flex h-9 items-center gap-1.5 border border-neon-cyan/60 bg-void/90 px-3 font-mono text-[10px] uppercase tracking-widest text-neon-cyan shadow-[0_0_12px_rgba(0,255,255,0.15)] transition-colors hover:bg-neon-cyan/10"
        >
          <ArrowDown className="h-3 w-3" />
          {newMsgCount > 0
            ? `\u2193 ${newMsgCount} ${t('msg.newMessages')}`
            : t('chat.scrollToBottom')}
        </button>
      ) : null}

      <div className="shrink-0 bg-void">
        <ChatInput
          sendText={sendText}
          sendMedia={sendMedia}
          sendAlbum={sendAlbum}
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
                useSessionStore.getState().setActiveChatId(existing.id)
              } else {
                const chat = await createDirectE2EChat(userId, profileTarget.userId)
                useSessionStore.getState().setActiveChatId(chat.id)
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

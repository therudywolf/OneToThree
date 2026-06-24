'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Crown, Star, ArrowDown, ShieldOff } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { useUnreadStore } from '@/store/unreadStore'
import { getFmSocket } from '@/lib/api/socket'
import { MediaMessage } from '@/components/chat/media-message'
import { ChatInput } from '@/components/chat/chat-input'
import { parseAlbumEnvelope, parseAttachmentEnvelope, parseStickerEnvelope } from '@/lib/attachment-envelope'
import { MessageRow } from '@/components/chat/message-row'
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
import { getChatPrivacy } from '@/lib/chat-privacy'
import { setNativeFlagSecure } from '@/lib/native-flag-secure'
import { MessageActions } from '@/components/chat/message-actions'
import { UserAvatar } from '@/components/user-avatar'
import { createDirectE2EChat, fetchChatsList, type ApiChatRow, type ChatMemberRole } from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'
import { useReadReceipts } from '@/hooks/use-read-receipts'
import { useStickyScroll } from '@/hooks/use-sticky-scroll'
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
import { toastError, toastSuccess, toastWarn } from '@/store/toastStore'
import { TELEGRAM_BEHAVIOR } from '@/components/chat/telegram-behavior'
import { explainStickerError } from '@/lib/sticker-errors'

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
    opts?: { burn_duration_secs?: number | null }
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

  // Tick counter so burn-timer countdowns re-render every second.
  const [, setBurnTick] = useState(0)
  // Stable signature of the *armed* burn timers (id+deadline). Only changes when
  // a burn timer is added/removed/retimed — NOT on every unrelated message
  // append or read receipt. Keying the interval off this string means we don't
  // tear down and recreate the per-second timer on every store update (D22).
  const burnSignature = useMemo(
    () =>
      messages
        .filter((m) => m.burn_at)
        .map((m) => `${m.id}:${m.burn_at}`)
        .sort()
        .join('|'),
    [messages]
  )
  useEffect(() => {
    if (!burnSignature) return
    const id = setInterval(() => {
      const now = Date.now()
      // Read the latest messages from the store inside the tick so we always act
      // on current state without listing `messages` as an effect dependency.
      for (const m of useChatStore.getState().messages) {
        if (m.burn_at && new Date(m.burn_at).getTime() <= now) {
          removeMessage(m.id)
        }
      }
      setBurnTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [burnSignature, removeMessage])
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
  const lightboxMetaRef = useRef<Map<string, { mediaPath: string; mediaIv: string; plaintext?: string; wrapCt?: string; wrapIv?: string }>>(new Map())
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
  // === Autoscroll state ===
  //
  // Sticky/anchor scroll is owned by useStickyScroll (see ./use-sticky-scroll
  // for the design). chat-terminal only tracks "did the tail change?" and the
  // floating "new messages below" chip; everything position-related lives in
  // the hook.
  const [hasNewBelow, setHasNewBelow] = useState(false)
  // Tail identity (id, created_at). Survives the 50-msg ring buffer where
  // `messages.length` stays constant while the tail rotates.
  const lastMsgKeyRef = useRef<string | null>(null)
  const firstMessagesRenderRef = useRef(true)
  const swipeRef = useRef<{ startX: number; startY: number; msgId: string } | null>(null)
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  // Mirror of swipeOffset so the swipe-commit handler can stay referentially
  // stable (no swipeOffset in its dep array) — keeps memoized rows from
  // re-rendering on every swipe tick.
  const swipeOffsetRef = useRef(0)

  // Forward modal
  const [forwardMsg, setForwardMsg] = useState<DecryptedMessage | null>(null)
  // Thread panel
  const [threadRoot, setThreadRoot] = useState<DecryptedMessage | null>(null)

  const isGroup = activeChat?.is_group ?? false
  // Privacy flags drive the no-copy / blank-on-blur DOM behaviour. Stored in
  // localStorage; per-chat override falls back to global. Honest UX: best
  // effort, no cryptographic guarantee — see lib/chat-privacy.ts.
  const [privacy, setPrivacy] = useState(() =>
    activeChatId ? getChatPrivacy(activeChatId) : { noCopy: false, blankOnBlur: false }
  )
  useEffect(() => {
    if (!activeChatId) return
    setPrivacy(getChatPrivacy(activeChatId))
  }, [activeChatId])
  const [hideForBlur, setHideForBlur] = useState(false)
  useEffect(() => {
    if (!privacy.blankOnBlur) {
      setHideForBlur(false)
      return
    }
    const onVis = () => setHideForBlur(document.visibilityState !== 'visible' || !document.hasFocus())
    onVis()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [privacy.blankOnBlur])
  // Block clipboard when noCopy is on. Targets bubble text only — captions
  // in the composer remain copy-able by design (you wrote it, you own it).
  useEffect(() => {
    if (!privacy.noCopy) return
    const el = ref.current
    if (!el) return
    const block = (e: Event) => { e.preventDefault() }
    el.addEventListener('copy', block)
    el.addEventListener('cut', block)
    el.addEventListener('contextmenu', block)
    return () => {
      el.removeEventListener('copy', block)
      el.removeEventListener('cut', block)
      el.removeEventListener('contextmenu', block)
    }
  }, [privacy.noCopy])
  // Native (Android) FLAG_SECURE bridge — actually blocks screenshots
  // when running inside Capacitor with the Privacy plugin installed.
  // Web is a no-op. On chat exit / privacy toggle off, FLAG_SECURE is
  // released so the rest of the app stays screenshot-able.
  useEffect(() => {
    void setNativeFlagSecure(privacy.noCopy)
    return () => { void setNativeFlagSecure(false) }
  }, [privacy.noCopy])
  const isSelfChat = activeChat != null && isSavedMessagesChat(activeChat, userId)

  useReadReceipts(ref, { enabled: !isGroup })

  const onAtBottomChange = useCallback((atBottom: boolean) => {
    if (atBottom) {
      setHasNewBelow(false)
      setNewMsgCount(0)
    }
  }, [])
  const sticky = useStickyScroll(ref, {
    thresholdPx: TELEGRAM_BEHAVIOR.autoscroll.stickPx,
    onAtBottomChange,
  })
  const { isAtBottomRef, jumpToBottom, smoothToBottom, captureAnchor } = sticky

  // NEW MESSAGE arrival.
  //   - sent by me            → force-jump to bottom
  //   - sent by peer & sticky → hook's RO will re-snap on layout change;
  //                             nothing to do here.
  //   - sent by peer & !sticky → flag "N new messages below" chip
  useEffect(() => {
    if (messages.length === 0) {
      lastMsgKeyRef.current = null
      return
    }
    const newest = messages[messages.length - 1]
    const key = `${newest.id}:${newest.created_at}`
    if (firstMessagesRenderRef.current) {
      firstMessagesRenderRef.current = false
      lastMsgKeyRef.current = key
      return
    }
    if (lastMsgKeyRef.current === key) return
    lastMsgKeyRef.current = key

    const sentByMe = newest.sender_id === userId
    if (sentByMe) {
      jumpToBottom()
    } else if (!isAtBottomRef.current) {
      setHasNewBelow(true)
      setNewMsgCount((prev) => prev + 1)
    }
  }, [messages, userId, jumpToBottom, isAtBottomRef])

  const scrollToBottom = useCallback(() => {
    smoothToBottom()
    setHasNewBelow(false)
    setNewMsgCount(0)
  }, [smoothToBottom])

  const renderMessages = useMemo(() => {
    const map = new Map<string, DecryptedMessage>()
    for (const m of [...olderMessages, ...messages]) {
      map.set(m.id, m)
    }
    // IMPORTANT: keep each message's object identity stable. We deliberately do
    // NOT spread `{...m, read_at}` here — minting a new identity for every row on
    // each read-receipt would break `MessageRow`'s memo and re-render the whole
    // list. The read-at override is threaded into each row as a narrow per-row
    // prop instead (see `readAtOverrides[m.id]` at the render site).
    return [...map.values()].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
  }, [olderMessages, messages])

  const groupedMessages = useMemo(() => {
    return groupMessages(renderMessages)
  }, [renderMessages])

  // Live mirror of renderMessages for stable callbacks (swipe-commit) that
  // must not list renderMessages in their dependency array.
  const renderMessagesRef = useRef(renderMessages)
  useEffect(() => {
    renderMessagesRef.current = renderMessages
  }, [renderMessages])

  // Stable sorted-id key for the set of peer senders. The key only changes when
  // the *set* of senders changes — not on every read receipt / message append
  // that leaves the membership untouched. This both stabilises the memo below
  // and keys the resolve effect so it doesn't re-fire spuriously (D8).
  const senderIdsKey = useMemo(() => {
    if (!isGroup || !activeChatId) return ''
    const ids = new Set<string>()
    for (const m of renderMessages) {
      if (m.sender_id !== userId) ids.add(m.sender_id)
    }
    return [...ids].sort().join(',')
  }, [isGroup, activeChatId, renderMessages, userId])

  const senderIdsToResolve = useMemo(
    () => (senderIdsKey ? senderIdsKey.split(',') : []),
    [senderIdsKey]
  )

  useEffect(() => {
    if (!senderIdsToResolve.length) return
    let cancelled = false
    void lookupUsers(senderIdsToResolve)
      .then((rows) => {
        if (cancelled) return
        // Merge — don't reset to {} — so previously-resolved senders keep their
        // labels/avatars while new ones resolve (avoids a flash of fallback
        // initials when the sender set grows).
        setSenderMeta((prev) => {
          const next = { ...prev }
          for (const u of rows) {
            next[u.id] = { username: u.username, avatar_key: u.avatar_key }
          }
          return next
        })
      })
      .catch(() => {
        // Keep whatever we already resolved on failure rather than wiping it.
      })
    return () => {
      cancelled = true
    }
  }, [senderIdsToResolve])

  // Pinned for first-unread anchor. Frozen at the moment the chat opens
  // so that incoming messages don't keep shifting the marker down.
  const [firstUnreadAnchorId, setFirstUnreadAnchorId] = useState<string | null>(null)
  const firstUnreadIdRef = useRef<string | null>(null)
  // Tracks whether we already scrolled to the first-unread anchor for this chat open.
  const didScrollToUnreadRef = useRef(false)

  useLayoutEffect(() => {
    setOlderMessages([])
    setHasMoreOlder(true)
    setLoadingOlder(false)
    lastMsgKeyRef.current = null
    firstMessagesRenderRef.current = true
    firstUnreadIdRef.current = null
    didScrollToUnreadRef.current = false
    setFirstUnreadAnchorId(null)
    setHasNewBelow(false)
    setNewMsgCount(0)
    // Snap to the tail synchronously before the next paint. The hook's
    // ResizeObserver keeps us pinned as decrypted bubbles mount in (since
    // jumpToBottom set isAtBottomRef=true), so no flicker.
    jumpToBottom()
  }, [activeChatId, jumpToBottom])

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

  // Once the first-unread anchor is resolved, scroll so the unread divider is
  // visible at the top of the viewport (instead of staying at the bottom).
  useEffect(() => {
    if (!firstUnreadAnchorId || didScrollToUnreadRef.current) return
    didScrollToUnreadRef.current = true
    // Double-rAF to let pending hook restorations complete first, then place
    // the unread divider 52px below the viewport top via the sticky API
    // (which also captures it as the restoration anchor for any subsequent
    // layout changes — late media decode, etc).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollEl = ref.current
        if (!scrollEl) return
        const target = scrollEl.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(firstUnreadAnchorId)}"]`
        )
        if (!target) return
        sticky.scrollToElement(target, 52)
      })
    })
  }, [firstUnreadAnchorId, sticky])

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
      // Undecryptable rows: only deletes are meaningful. Block everything
      // else defensively in case a stale UI element triggered it.
      if (
        msg.plaintext === '[DECRYPT_FAIL]' &&
        action !== 'deleteForMe' &&
        action !== 'deleteForAll'
      ) {
        return
      }
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
          if (!window.confirm(t('chat.deleteForMeConfirm'))) {
            break
          }
          removeMessage(msg.id)
          void deleteCachedMessage(msg.id, msg.chat_id)
          toastSuccess(t('chat.originalDeleted'))
          break
        case 'deleteForAll':
          if (mine) {
            if (!window.confirm(t('chat.deleteForAllConfirm'))) {
              break
            }
            void (async () => {
              try {
                await deleteMessage(msg.id, true)
                removeMessage(msg.id)
                await deleteCachedMessage(msg.id, msg.chat_id)
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
                toastError(
                  explainStickerError(err instanceof Error ? err.message : 'STICKER_SAVE_FAILED', t),
                  { title: 'Stickers' }
                )
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
            } catch {
              toastError(t('gif.favoriteAddFailed'), { title: 'GIF' })
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

      const result = await sendChatMessageOverTransport({
        chat_id: chatId,
        transport_mode: meta.ctx.mode,
        plaintext: text,
        sender_private_key: privateKeyForForward,
        my_user_id: userId,
        peer_user_id: meta.peerUserId ?? undefined,
        my_ecdh_public_key_jwk: useSessionStore.getState().myEcdhPublicKeyJwk,
        content: encrypted_content,
        iv,
        reply_to_id: null,
      })
      if (result.partialDelivery && result.partialDelivery.failedDeviceIds.length > 0) {
        toastWarn(
          `${t('chat.partialDeliveryWarning')} (${result.partialDelivery.failedDeviceIds.length}/${result.partialDelivery.attemptedDeviceIds.length})`,
          { title: t('chat.partialDeliveryTitle'), ttlMs: 7000 }
        )
      }
    },
    [userId, privateKeyForForward, t]
  )

  const handleToggleReaction = useCallback(
    (emoji: string, msgId: string) => {
      if (!activeChat?.id) return
      // Don't react on rows that never decrypted — the server-stored row is
      // unreadable to all participants and the reaction would be meaningless.
      const target = useChatStore.getState().messages.find((n) => n.id === msgId)
      if (target && target.plaintext === '[DECRYPT_FAIL]') return
      getFmSocket().send({
        type: 'toggle_reaction',
        message_id: msgId,
        chat_id: activeChat.id,
        emoji,
      })
    },
    [activeChat?.id],
  )

  // Open the message context menu at a viewport point, clamped so the menu
  // stays on-screen. Stable identity — passed to every memoized MessageRow.
  const handleOpenContextMenu = useCallback(
    (msg: DecryptedMessage, clientX: number, clientY: number) => {
      const pad = 8
      const mw = 200
      const mh = 320
      const vw = typeof window !== 'undefined' ? window.innerWidth : clientX
      const vh = typeof window !== 'undefined' ? window.innerHeight : clientY
      const x = Math.min(clientX, vw - mw - pad)
      const y = Math.min(clientY, vh - mh - pad)
      setCtxMenu({
        msg,
        x: Math.max(pad, x),
        y: Math.max(pad, y),
        isMine: msg.sender_id === userId,
      })
    },
    [userId],
  )

  // Open the quick-react bar for a message; pass a falsy id to close it.
  const handleSetReacting = useCallback((msgId: string) => {
    setReactingMsgId(msgId || null)
  }, [])

  const handleOpenThread = useCallback((msg: DecryptedMessage) => {
    setThreadRoot(msg)
  }, [])

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
      swipeOffsetRef.current = 0
      setSwipeOffset(0)
      return
    }
    if (dx > TELEGRAM_BEHAVIOR.gestures.swipeReplyStartPx) {
      const next = Math.min(dx, TELEGRAM_BEHAVIOR.gestures.swipeReplyMaxPx)
      setSwipingMsgId(swipeRef.current.msgId)
      swipeOffsetRef.current = next
      setSwipeOffset(next)
    }
  }, [handleTouchEnd])

  // Stable identity: reads the live offset / message list from refs so the
  // memoized MessageRow does not re-render on every swipe-offset tick.
  const handleSwipeEnd = useCallback(() => {
    if (swipeRef.current && swipeOffsetRef.current > TELEGRAM_BEHAVIOR.gestures.swipeReplyCommitPx) {
      const msg = renderMessagesRef.current.find((m) => m.id === swipeRef.current!.msgId)
      if (msg) setReplyTo(msg)
    }
    swipeRef.current = null
    setSwipingMsgId(null)
    swipeOffsetRef.current = 0
    setSwipeOffset(0)
  }, [setReplyTo])

  // Combined touch-end / touch-cancel for a message row — stable identity.
  const handleRowTouchEnd = useCallback(() => {
    handleTouchEnd()
    handleSwipeEnd()
  }, [handleTouchEnd, handleSwipeEnd])

  const msgById = (id: string) => renderMessages.find((m) => m.id === id)
  const oldestLoaded = renderMessages[0] ?? null

  // useCallback so the memoized MessageRow's props stay referentially stable
  // across unrelated ChatTerminal state changes.
  const labelForSender = useCallback(
    (senderId: string): string => {
      if (senderId === userId) {
        return currentUsername.trim() || 'YOU'
      }
      if (!isGroup) {
        return directPeerUsername?.trim() || shortId(senderId)
      }
      return senderMeta[senderId]?.username?.trim() || shortId(senderId)
    },
    [userId, currentUsername, isGroup, directPeerUsername, senderMeta],
  )

  const avatarKeyForSender = useCallback(
    (senderId: string): string | null | undefined => {
      if (senderId === userId) return myAvatarKey ?? null
      if (!isGroup) return peerAvatarKey ?? null
      return senderMeta[senderId]?.avatar_key
    },
    [userId, myAvatarKey, isGroup, peerAvatarKey, senderMeta],
  )

  // Pure — no closure deps; stable identity for the whole component lifetime.
  const replySnippet = useCallback((msg: DecryptedMessage): string => {
    const env = parseAttachmentEnvelope(msg.plaintext)
    if (env) return env.fileName.length > 48 ? `${env.fileName.slice(0, 48)}…` : env.fileName
    const st = parseStickerEnvelope(msg.plaintext)
    if (st) return st.fallbackEmoji?.trim() || '🎭'
    if (msg.plaintext && msg.plaintext !== '[DECRYPT_FAIL]') {
      return msg.plaintext.length > 60 ? `${msg.plaintext.slice(0, 60)}…` : msg.plaintext
    }
    if (msg.media_path) return '[MEDIA]'
    return '—'
  }, [])

  const voiceMessageIds = useMemo(() => {
    return renderMessages
      .filter((m) => m.media_type === 'audio' && m.media_path && m.media_iv)
      .map((m) => m.id)
  }, [renderMessages])

  // id -> position lookup so the message-row render does not call
  // voiceMessageIds.indexOf() per row (that made rendering O(n^2)).
  const voiceMessageIndex = useMemo(() => {
    const m = new Map<string, number>()
    voiceMessageIds.forEach((id, i) => m.set(id, i))
    return m
  }, [voiceMessageIds])

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

  const handleMediaClick = useCallback((media: { id: string; url: string; type: 'image' | 'video'; mimeType: string }) => {
    const allMedia: Array<{ id: string; url: string; type: 'image' | 'video'; mimeType: string }> = []
    const metaMap = new Map<string, { mediaPath: string; mediaIv: string; plaintext?: string; wrapCt?: string; wrapIv?: string }>()

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
        return
      }
      // Album: media lives in the encrypted envelope (no media_path). Expand one
      // lightbox entry per item, keyed ${msg.id}#${idx} to match the id
      // AlbumBubble fires on click, with the item's own wrapped key in meta.
      const album = msg.plaintext ? parseAlbumEnvelope(msg.plaintext) : null
      if (album) {
        album.items.forEach((it, idx) => {
          const isVid = it.kind === 'video' || /^video\//i.test(it.mimeType)
          const isImg = it.kind === 'image' || /^image\//i.test(it.mimeType)
          if (!isVid && !isImg) return
          const id = `${msg.id}#${idx}`
          allMedia.push({
            id,
            url: '',
            type: isVid ? 'video' : 'image',
            mimeType: it.mimeType.split(';')[0],
          })
          metaMap.set(id, {
            mediaPath: it.path,
            mediaIv: it.iv,
            wrapCt: it.wrapCt || undefined,
            wrapIv: it.wrapIv || undefined,
          })
        })
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
  }, [groupedMessages])

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
        // Album item: per-item wrapped AES key from the album envelope (carried
        // on meta as wrapCt/wrapIv) rather than a single-media attachment env.
        const wrapCt = meta.wrapCt ?? envelope?.wrapCt
        const wrapIv = meta.wrapIv ?? envelope?.wrapIv
        if (wrapCt && wrapIv) {
          const wrapPlain = await decryptBinary(
            sharedKey,
            base64ToArrayBuffer(wrapCt),
            wrapIv
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

  const openProfile = useCallback((senderId: string) => {
    setProfileTarget({
      userId: senderId,
      username: labelForSender(senderId),
      avatarKey: avatarKeyForSender(senderId),
    })
  }, [labelForSender, avatarKeyForSender])

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
        // Capture the topmost visible bubble as the anchor. The hook's
        // ResizeObserver fires after React commits the prepended rows; it
        // restores this same bubble to the same offset-within-viewport so
        // the user's reading position never jumps. No scrollHeight math.
        captureAnchor()
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
    captureAnchor,
  ])

  if (!activeChatId) {
    return (
      <div className="crt-terminal-vignette flex flex-1 flex-col items-center justify-center gap-2 bg-void px-6 text-center">
        <p className="text-sm font-medium text-[color:var(--on-surface)]">
          {t('chat.emptyTitle')}
        </p>
        <p className="max-w-xs text-xs leading-relaxed text-[color:var(--text-muted)]">
          {t('chat.emptySubtitle')}
        </p>
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
        data-privacy-no-copy={privacy.noCopy ? 'true' : undefined}
        data-privacy-blanked={hideForBlur ? 'true' : undefined}
        className={`p13-chat-scroll chat-scroll min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain pb-4 pt-3 text-sm [-webkit-overflow-scrolling:touch] ${privacy.noCopy ? 'select-none' : ''}`}
        style={{
          paddingLeft: 'max(0.5rem, env(safe-area-inset-left, 0px))',
          paddingRight: 'max(0.5rem, env(safe-area-inset-right, 0px))',
        }}
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
            const replyMsg = m.reply_to_id ? msgById(m.reply_to_id) ?? null : null
            const mine = m.sender_id === userId
            const showUnreadDivider =
              !!firstUnreadAnchorId && m.id === firstUnreadAnchorId
            const voiceIdx = voiceMessageIndex.get(m.id) ?? -1
            return (
              <div key={m.id} className="contents">
                {dateDivider}
                {showUnreadDivider ? (
                  <div className="chat-unread-divider">
                    {t('chat.unreadMessages') || 'UNREAD MESSAGES'}
                  </div>
                ) : null}
                <MessageRow
                  message={m}
                  readAtOverride={readAtOverrides[m.id]}
                  mine={mine}
                  isRunContinuation={isRunContinuation}
                  replyMsg={replyMsg}
                  sharedKey={sharedKey}
                  userId={userId}
                  currentUsername={currentUsername}
                  myAvatarKey={myAvatarKey}
                  locale={locale}
                  t={t}
                  senderLabel={labelForSender(m.sender_id)}
                  senderAvatarKey={avatarKeyForSender(m.sender_id)}
                  senderRole={isGroup ? senderRoles[m.sender_id] ?? null : null}
                  swipeOffset={swipingMsgId === m.id ? swipeOffset : 0}
                  isReacting={reactingMsgId === m.id}
                  hasPrevVoice={voiceIdx > 0}
                  hasNextVoice={voiceIdx >= 0 && voiceIdx < voiceMessageIds.length - 1}
                  labelForSender={labelForSender}
                  replySnippet={replySnippet}
                  onContextMenu={handleOpenContextMenu}
                  onTouchStart={handleTouchStart}
                  onSwipeStart={handleSwipeStart}
                  onSwipeMove={handleSwipeMove}
                  onTouchEnd={handleRowTouchEnd}
                  onMessageAction={handleMessageAction}
                  onSetReacting={handleSetReacting}
                  onToggleReaction={handleToggleReaction}
                  onMediaClick={handleMediaClick}
                  onOpenProfile={openProfile}
                  onOpenThread={handleOpenThread}
                  onNavigateVoice={navigateVoice}
                />
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
                        ? 'p13-msg-meta--mine flex-row-reverse justify-end text-right'
                        : 'p13-msg-meta--peer justify-start text-left'
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
                      className="cursor-pointer transition-colors hover:opacity-80"
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
                              onPrevVoice={(voiceMessageIndex.get(m.id) ?? -1) > 0 ? () => navigateVoice(m.id, 'prev') : undefined}
                              onNextVoice={(voiceMessageIndex.get(m.id) ?? -1) < voiceMessageIds.length - 1 ? () => navigateVoice(m.id, 'next') : undefined}
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
        {cryptoCtx?.mode === 'PUBLIC' && (
          <div
            role="alert"
            className="flex items-center gap-2 border-t border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger"
          >
            <ShieldOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>This conversation is not end-to-end encrypted. Messages may be visible to the server.</span>
          </div>
        )}
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

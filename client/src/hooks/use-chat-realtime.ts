'use client'

import { useEffect, useRef } from 'react'
import { acknowledgeMessagesDelivered, fetchPendingDeliveries } from '@/lib/api/messages'
import { getFmSocket } from '@/lib/api/socket'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { decryptApiMessageRows, type DrContext } from '@/lib/decrypt-chat-api-message'
import { cacheMessage, deleteCachedMessage } from '@/lib/message-cache'
import { playNotificationSound } from '@/lib/call-ringtones'
import { isChatIdMuted } from '@/lib/muted-chats'
import { lookupUsers } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { usePresenceStore } from '@/store/presenceStore'
import { useUnreadStore } from '@/store/unreadStore'
import type { DecryptedMessage } from '@/types/chat'

/** Give up retrying a pending slot that won't decrypt after this many pulls. */
const DECRYPT_RETRY_CAP = 5

export function useChatRealtime(
  cryptoCtx: ChatCryptoContext | null,
  triggerBackgroundPush?: (title: string, body: string, targetUrl?: string) => void,
  directPeerUserId?: string | null
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const userId = useSessionStore((s) => s.userId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const myEcdhPublicKeyJwk = useSessionStore((s) => s.myEcdhPublicKeyJwk)
  const priorMyEcdhPublicKeysJwk = useSessionStore((s) => s.priorMyEcdhPublicKeysJwk)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const updateMessageReadAt = useChatStore((s) => s.updateMessageReadAt)
  const updateMessageBurnAt = useChatStore((s) => s.updateMessageBurnAt)
  const updateMessageReactions = useChatStore((s) => s.updateMessageReactions)
  const updateMessagePlaintext = useChatStore((s) => s.updateMessagePlaintext)
  const chatSoundEnabled = useChatStore((s) => s.chatSoundEnabled)
  const setTypingUser = usePresenceStore((s) => s.setTypingUser)
  const clearTypingUser = usePresenceStore((s) => s.clearTypingUser)
  const clearTypingUserEverywhere = usePresenceStore((s) => s.clearTypingUserEverywhere)
  const pruneTypingUsers = usePresenceStore((s) => s.pruneTypingUsers)
  const trackInboundUnread = useUnreadStore((s) => s.trackInboundUnread)
  const usernameCacheRef = useRef<Record<string, string>>({})
  const pendingPullRef = useRef(false)
  /** Set when a fan-out event arrives while a pending-pull is in flight, so the
   * running pull repeats and a slot that committed after its snapshot isn't
   * silently missed until the next event. */
  const pendingPullAgainRef = useRef(false)
  /** Per-message count of consecutive decrypt failures during pending-pull, so a
   * transiently-undecryptable slot is retried (left pending) but a genuinely
   * corrupt one is given up on after a cap instead of pinning /sync/pending. */
  const decryptFailCountRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (!activeChatId) {
      return
    }

    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type === 'typing_start') {
        if (msg.chat_id !== activeChatId) return
        if (msg.user_id === userId) return
        const known = usernameCacheRef.current[msg.user_id]
        const uname =
          msg.username?.trim() || known || `user_${msg.user_id.slice(0, 8)}`
        usernameCacheRef.current[msg.user_id] = uname
        setTypingUser(activeChatId, msg.user_id, uname, 6000)
        if (!known) {
          void lookupUsers([msg.user_id])
            .then((rows) => {
              const row = rows[0]
              if (!row?.username) return
              usernameCacheRef.current[msg.user_id] = row.username
              setTypingUser(activeChatId, msg.user_id, row.username, 3000)
            })
            .catch(() => {
              /* ignore lookup failures */
            })
        }
        return
      }
      if (msg.type === 'typing_stop') {
        if (msg.chat_id !== activeChatId) return
        clearTypingUser(activeChatId, msg.user_id)
        return
      }
      if (msg.type === 'call_leave') {
        clearTypingUserEverywhere(msg.from_user_id)
        return
      }
      if (msg.type === 'message_deleted') {
        if (msg.chat_id === activeChatId) {
          removeMessage(msg.message_id)
          // The store only holds the newest RAM_CACHE_LIMIT rows. Anything the
          // user scrolled back to lives in ChatTerminal's local paginated window
          // and is invisible to removeMessage, so it stayed on screen after the
          // peer deleted it for everyone. Announce it so the view can drop it.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('p13:message-deleted', {
                detail: { id: msg.message_id, chatId: msg.chat_id },
              })
            )
          }
        }
        void deleteCachedMessage(msg.message_id, msg.chat_id)
        return
      }
      if (msg.type === 'message_edited') {
        if (msg.chat_id !== activeChatId) return
        const editedId = msg.message_id
        const editedAt = msg.edited_at
        const keepExisting = () =>
          updateMessagePlaintext(
            editedId,
            useChatStore.getState().messages.find((m) => m.id === editedId)?.plaintext ?? '',
            editedAt
          )
        if (msg.content != null && msg.iv != null && unwrappedPrivateKey && cryptoCtx) {
          // Group/public/sector edit: `content` is CIPHERTEXT, not plaintext.
          // Decrypt it with the active chat's crypto context before storing —
          // otherwise the bubble shows a raw base64 blob until reload. (DIRECT
          // fan-out edits arrive with content=null and fall to keepExisting.)
          void decryptApiMessageRows(
            unwrappedPrivateKey,
            cryptoCtx,
            [{ id: editedId, chat_id: msg.chat_id, sender_id: userId ?? '', content: msg.content, iv: msg.iv, created_at: editedAt }],
            undefined,
            { myUserId: userId ?? undefined, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
          )
            .then((out) => {
              const pt = out[0]?.plaintext
              if (pt != null && pt !== '[DECRYPT_FAIL]') updateMessagePlaintext(editedId, pt, editedAt)
              else keepExisting()
            })
            .catch(keepExisting)
        } else if (
          unwrappedPrivateKey &&
          cryptoCtx &&
          (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF')
        ) {
          // Fan-out edit (DIRECT peer devices, or SELF own devices): every
          // delivery slot was re-encrypted with a fresh ciphertext and its
          // deliveredAt reset server-side, so re-pull and re-decrypt — the new
          // text REPLACES the old one on the other device, not just a label.
          // SELF decrypt uses the self-fanout slot path (no drCtx needed).
          const drCtx: DrContext | undefined =
            userId && directPeerUserId
              ? { ownerUserId: userId, peerUserId: directPeerUserId }
              : undefined
          void (async () => {
            try {
              const pending = await fetchPendingDeliveries(activeChatId)
              const target = pending.filter((p) => p.id === editedId)
              if (target.length === 0) {
                keepExisting()
                return
              }
              const rows = await decryptApiMessageRows(
                unwrappedPrivateKey,
                cryptoCtx,
                target,
                drCtx,
                { myUserId: userId ?? undefined, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
              )
              const pt = rows[0]?.plaintext
              if (pt != null && pt !== '[DECRYPT_FAIL]') {
                if (rows[0]) await cacheMessage(rows[0]).catch(() => { /* best-effort */ })
                updateMessagePlaintext(editedId, pt, editedAt)
                await acknowledgeMessagesDelivered([editedId]).catch(() => { /* best-effort */ })
              } else {
                keepExisting()
              }
            } catch {
              keepExisting()
            }
          })()
        } else {
          // No crypto context: keep the existing plaintext, just stamp editedAt
          // so the "edited" label shows.
          keepExisting()
        }
        return
      }
      if (msg.type === 'poll_updated') {
        // Dispatch a custom DOM event so PollBubble instances can refresh
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('p13:poll_updated', { detail: { poll_id: msg.poll_id, results: msg.results } })
          )
        }
        return
      }
      if (msg.type === 'message_read_update') {
        if (msg.chat_id !== activeChatId) return
        updateMessageReadAt(msg.message_id, msg.read_at)
        // If the server computed burn_at at read time, propagate it to the store
        if (msg.burn_at) {
          updateMessageBurnAt(msg.message_id, msg.burn_at)
        }
        const row = useChatStore
          .getState()
          .messages.find((x) => x.id === msg.message_id)
        const updatedRow = {
          ...row,
          read_at: msg.read_at,
          ...(msg.burn_at ? { burn_at: msg.burn_at } : {}),
        }
        if (row) void cacheMessage(updatedRow as typeof row)
        return
      }
      if (msg.type === 'reaction_update') {
        if (msg.chat_id === activeChatId) {
          updateMessageReactions(msg.message_id, msg.reactions)
        }
        return
      }
      if (msg.type === 'message_pin_changed') {
        if (msg.chat_id !== activeChatId) return
        useChatStore.setState((s) => ({
          messages: s.messages.map((row) =>
            row.id === msg.message_id
              ? { ...row, is_pinned: msg.is_pinned }
              : row
          ),
        }))
        return
      }
      if (msg.type !== 'chat_message') return
      const m = msg.message
      // NOTE: neither unread/mention tracking NOR the notification trigger live
      // here — this effect is gated on `activeChatId`, so both would stop the
      // moment no chat is open. They run in their own ungated effect below (#5).
      if (!cryptoCtx || !unwrappedPrivateKey) return
      if (m.chat_id !== activeChatId) return

      // Build DR context when we know both sides of the conversation.
      const drCtx: DrContext | undefined =
        userId && directPeerUserId
          ? { ownerUserId: userId, peerUserId: directPeerUserId }
          : undefined

      void (async () => {
        if ((m.content == null || m.content === '') && m.sender_id === userId) {
          // Fan-out WS events do not carry the sender's own slot. If THIS tab
          // sent the message, the REST handler already appended the row, so
          // skip. But OTHER devices/tabs of the same user did NOT — they need
          // to pull the pending delivery slot to render the message.
          const alreadyInStore = useChatStore
            .getState()
            .messages.some((x) => x.id === m.id)
          if (alreadyInStore) return
          // Fall through into the pending-pull branch below.
        }
        if ((m.content == null || m.content === '')) {
          if (pendingPullRef.current) {
            // A pull is already running — request a re-run instead of dropping
            // this event, so a slot committed after the in-flight snapshot is
            // still fetched.
            pendingPullAgainRef.current = true
            return
          }
          pendingPullRef.current = true
          try {
            do {
              pendingPullAgainRef.current = false
              // This loop is bound to the chat + crypto context it started for
              // (activeChatId / cryptoCtx / drCtx closures). If the user switched
              // chats while a pass was in flight, STOP: the freshly-mounted effect
              // handles the new chat with its own keys. Continuing would fetch the
              // old chat's slots, decrypt them with the wrong (or right) keys, and
              // appendMessage() them into the now-open chat — injecting another
              // chat's messages and starving the new chat's own delivery.
              if (useSessionStore.getState().activeChatId !== activeChatId) break
              const pending = await fetchPendingDeliveries(activeChatId)
              if (pending.length === 0) continue
              const rows = await decryptApiMessageRows(
                unwrappedPrivateKey,
                cryptoCtx,
                pending,
                drCtx,
                { myUserId: userId ?? undefined, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk }
              )
              const ids: string[] = []
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i]
                if (!row) continue
                // Guard again in case the chat switched during the decrypt await.
                if (useSessionStore.getState().activeChatId !== activeChatId) break
                const id = pending[i]?.id
                if (row.plaintext === '[DECRYPT_FAIL]' && id) {
                  // Transient failure (e.g. DR session not provisioned yet):
                  // don't show or ack it yet — leave it pending so the next pull
                  // retries and renders the real plaintext (appendMessage dedups
                  // by id, so showing the placeholder first would stick). Give up
                  // after the cap and surface the failure rather than loop.
                  const n = (decryptFailCountRef.current.get(id) ?? 0) + 1
                  decryptFailCountRef.current.set(id, n)
                  if (n < DECRYPT_RETRY_CAP) continue
                }
                await cacheMessage(row).catch(() => { /* best-effort */ })
                appendMessage(row)
                if (id) {
                  decryptFailCountRef.current.delete(id)
                  ids.push(id)
                }
              }
              if (ids.length > 0) {
                await acknowledgeMessagesDelivered(ids).catch(() => { /* best-effort */ })
              }
            } while (pendingPullAgainRef.current)
          } finally {
            pendingPullRef.current = false
          }
          return
        }

        // Legacy/group path: message has shared content on the wire.
        // Per-device DR v2 never travels here — its ciphertext lives only in
        // device delivery slots (content is null), so it is handled by the
        // pending-pull branch above.
        let plaintext = ''
        let isSystemStamped = false
        let kind: string | undefined
        let kindMeta: Record<string, unknown> | undefined
        if (m.content != null && m.iv != null && m.content !== '') {
          if (m.iv === 'poll:v1' || m.iv === 'system:v1') {
            // Server-originated sentinel rows carry plain JSON, not ciphertext
            // (poll envelopes, missed-call/system notices). The history-load
            // path special-cases these (decrypt-chat-api-message.ts:133-136);
            // the realtime branch must mirror it or polls and missed-call rows
            // render as [DECRYPT_FAIL] live until the user reloads. This runs
            // before the DIRECT downgrade-refusal because these sentinels are
            // legitimately delivered into DIRECT chats too.
            plaintext = m.content
            if (m.iv === 'system:v1') {
              // Record the sentinel, not just what it decoded to: it is written
              // by the server alone, and it is the only thing that separates a
              // real call notice from a peer who typed the same JSON. The
              // renderers refuse to draw a notice without it.
              isSystemStamped = true
              try {
                const parsed = JSON.parse(plaintext) as Record<string, unknown>
                kind = typeof parsed.kind === 'string' ? parsed.kind : undefined
                kindMeta = parsed
              } catch { /* not JSON — ignore */ }
            }
          } else if (cryptoCtx.mode === 'DIRECT') {
            // DIRECT chats are Double Ratchet (v2) only and never carry shared
            // wire content — a DIRECT chat_message with `content` set is a v1
            // protocol-downgrade attempt. Refuse to decrypt it.
            //
            // Refusing in silence made this indistinguishable from a key
            // problem: the bubble says "could not be decrypted" either way.
            // A downgrade attempt is worth naming, and so is the far more
            // likely benign case — a row judged against the wrong chat's
            // context.
            console.warn('[dr] refused a v1 row in a DIRECT chat', {
              id: m.id,
              chatId: m.chat_id,
            })
            plaintext = '[DECRYPT_FAIL]'
          } else {
            try {
              const { decryptInboundText } = await import('@/lib/chat-crypto')
              plaintext = await decryptInboundText(unwrappedPrivateKey, cryptoCtx, m.content, m.iv)
            } catch (err) {
              // The third place a decrypt used to fail in silence. This one
              // renders the bubble a user actually complains about, so it is the
              // one worth naming: a sector row that fails every key in the ring
              // is normally a message sealed under an epoch this member was
              // never given, not a broken key.
              console.warn('[dr] realtime decrypt failed', {
                id: m.id,
                mode: cryptoCtx.mode,
                reason: err instanceof Error ? err.message || err.name : String(err),
              })
              plaintext = '[DECRYPT_FAIL]'
            }
          }
        }

        const mediaType =
          m.media_type === 'audio' || m.media_type === 'video' ||
          m.media_type === 'image' || m.media_type === 'file'
            ? m.media_type
            : null

        const row: DecryptedMessage = {
          id: m.id,
          chat_id: m.chat_id,
          sender_id: m.sender_id,
          reply_to_id: m.reply_to_id ?? null,
          plaintext,
          created_at: m.created_at,
          read_at: m.read_at ?? null,
          media_path: m.media_path,
          media_type: mediaType,
          media_iv: m.media_iv,
          media_original_bytes: (m as { media_original_bytes?: number | null }).media_original_bytes ?? null,
          burn_at: m.burn_at ?? null,
          is_pinned: (m as { is_pinned?: boolean }).is_pinned ?? false,
          reactions: (m as { reactions?: Record<string, string[]> }).reactions ?? {},
          ...(kind !== undefined ? { kind, kindMeta } : {}),
          ...(isSystemStamped ? { isSystemStamped: true } : {}),
        }
        await cacheMessage(row).catch(() => { /* best-effort */ })
        appendMessage(row)
        if (userId && m.sender_id !== userId) {
          void acknowledgeMessagesDelivered([m.id]).catch(() => { /* best-effort */ })
        }
      })()
    })

    return off
  }, [
    activeChatId,
    appendMessage,
    clearTypingUser,
    clearTypingUserEverywhere,
    cryptoCtx,
    directPeerUserId,
    pruneTypingUsers,
    removeMessage,
    setTypingUser,
    trackInboundUnread,
    unwrappedPrivateKey,
    myEcdhPublicKeyJwk,
    priorMyEcdhPublicKeysJwk,
    updateMessageReadAt,
    updateMessageBurnAt,
    updateMessageReactions,
    userId,
  ])

  /**
   * Unread + mention tracking AND the notification trigger, deliberately NOT
   * gated on `activeChatId` (#5).
   *
   * The main realtime effect above returns early when no chat is open, so while
   * the user sits on the chat list — or has the app backgrounded with no chat
   * selected — it never subscribes and NOTHING happened: unread badges and
   * mention counts both stayed at zero, and no chime/push fired either. The
   * notification case is the worse half: the WS is still connected, so the
   * server sees the device as online and skips Web Push/FCM entirely, meaning a
   * backgrounded app with no chat selected got NO notification from anywhere.
   * This effect owns both, for every chat, and depends only on the user id.
   */
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type !== 'chat_message') return
      const m = msg.message
      if (m.sender_id === userId) return
      // Per-chat mute: suppress both the local chime and the background push
      // trigger entirely. Unread tracking below still runs so counters update —
      // muting is a notification concern, not a read-state one.
      if (!isChatIdMuted(m.chat_id)) {
        // Play sound only if chatSoundEnabled AND window is NOT focused
        // (while focused the user sees the chat, no need to interrupt)
        if (chatSoundEnabled && !document.hasFocus()) {
          playNotificationSound()
        }
        if (triggerBackgroundPush) {
          triggerBackgroundPush(
            'Project 13: Новая активность',
            'Получено новое зашифрованное сообщение',
            `/?chat=${encodeURIComponent(m.chat_id)}`
          )
        }
      }
      trackInboundUnread({
        chatId: m.chat_id,
        senderId: m.sender_id,
        replyToId: m.reply_to_id ?? null,
        // Straight off the wire — no longer inferred from the loaded message
        // window, which only ever covered the currently open chat.
        replyToSenderId: m.reply_to_sender_id ?? null,
        isForegroundVisible: document.visibilityState === 'visible',
        isActiveChat: m.chat_id === useSessionStore.getState().activeChatId,
        userId,
      })
    })
    return () => off()
  }, [userId, trackInboundUnread, chatSoundEnabled, triggerBackgroundPush])

  useEffect(() => {
    const id = window.setInterval(() => pruneTypingUsers(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pruneTypingUsers])
}

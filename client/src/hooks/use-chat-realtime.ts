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
        if (msg.chat_id === activeChatId) removeMessage(msg.message_id)
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
        } else {
          // Fan-out (DIRECT) or no crypto context: keep the existing plaintext,
          // just stamp editedAt so the "edited" label shows.
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
      if (userId && m.sender_id !== userId) {
        trackInboundUnread({
          chatId: m.chat_id,
          senderId: m.sender_id,
          replyToId: m.reply_to_id ?? null,
          isForegroundVisible: document.visibilityState === 'visible',
          isActiveChat: m.chat_id === useSessionStore.getState().activeChatId,
          userId,
          messages: useChatStore.getState().messages,
        })
      }
      if (userId && m.sender_id !== userId) {
        // Per-chat mute: suppress both the local chime and the background
        // push trigger entirely. Unread tracking above still runs so counters
        // update — muting is a notification concern, not a read-state one.
        const muted = isChatIdMuted(m.chat_id)
        if (!muted) {
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
      }
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
          if (pendingPullRef.current) return
          pendingPullRef.current = true
          try {
            const pending = await fetchPendingDeliveries(activeChatId)
            if (pending.length === 0) return
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
              await cacheMessage(row).catch(() => { /* best-effort */ })
              appendMessage(row)
              const id = pending[i]?.id
              if (id) ids.push(id)
            }
            if (ids.length > 0) {
              await acknowledgeMessagesDelivered(ids).catch(() => { /* best-effort */ })
            }
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
        if (m.content != null && m.iv != null && m.content !== '') {
          if (cryptoCtx.mode === 'DIRECT') {
            // DIRECT chats are Double Ratchet (v2) only and never carry shared
            // wire content — a DIRECT chat_message with `content` set is a v1
            // protocol-downgrade attempt. Refuse to decrypt it.
            plaintext = '[DECRYPT_FAIL]'
          } else {
            try {
              const { decryptInboundText } = await import('@/lib/chat-crypto')
              plaintext = await decryptInboundText(unwrappedPrivateKey, cryptoCtx, m.content, m.iv)
            } catch {
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
    chatSoundEnabled,
    clearTypingUser,
    clearTypingUserEverywhere,
    cryptoCtx,
    directPeerUserId,
    pruneTypingUsers,
    removeMessage,
    setTypingUser,
    trackInboundUnread,
    triggerBackgroundPush,
    unwrappedPrivateKey,
    myEcdhPublicKeyJwk,
    priorMyEcdhPublicKeysJwk,
    updateMessageReadAt,
    updateMessageBurnAt,
    updateMessageReactions,
    userId,
  ])

  useEffect(() => {
    const id = window.setInterval(() => pruneTypingUsers(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pruneTypingUsers])
}

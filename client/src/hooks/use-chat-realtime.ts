'use client'

import { useEffect, useRef } from 'react'
import { acknowledgeMessagesDelivered, fetchPendingDeliveries } from '@/lib/api/messages'
import { getFmSocket } from '@/lib/api/socket'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { decryptApiMessageRows, type DrContext } from '@/lib/decrypt-chat-api-message'
import { DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'
import { cacheMessage, deleteCachedMessage } from '@/lib/message-cache'
import { playNotificationSound } from '@/lib/call-ringtones'
import { isChatIdMuted } from '@/lib/muted-chats'
import { lookupUsers } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

export function useChatRealtime(
  cryptoCtx: ChatCryptoContext | null,
  triggerBackgroundPush?: (title: string, body: string, targetUrl?: string) => void,
  directPeerUserId?: string | null
) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const userId = useChatStore((s) => s.userId)
  const setTypingUser = useChatStore((s) => s.setTypingUser)
  const clearTypingUser = useChatStore((s) => s.clearTypingUser)
  const clearTypingUserEverywhere = useChatStore((s) => s.clearTypingUserEverywhere)
  const pruneTypingUsers = useChatStore((s) => s.pruneTypingUsers)
  const updateMessageReadAt = useChatStore((s) => s.updateMessageReadAt)
  const updateMessageReactions = useChatStore((s) => s.updateMessageReactions)
  const trackInboundUnread = useChatStore((s) => s.trackInboundUnread)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const chatSoundEnabled = useChatStore((s) => s.chatSoundEnabled)
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
        setTypingUser(activeChatId, msg.user_id, uname, 3000)
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
        void deleteCachedMessage(msg.message_id)
        return
      }
      if (msg.type === 'message_read_update') {
        if (msg.chat_id !== activeChatId) return
        updateMessageReadAt(msg.message_id, msg.read_at)
        const row = useChatStore
          .getState()
          .messages.find((x) => x.id === msg.message_id)
        if (row) void cacheMessage({ ...row, read_at: msg.read_at })
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
          isActiveChat: m.chat_id === useChatStore.getState().activeChatId,
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
          // Fan-out WS events do not carry the sender's own slot.
          // The active sender tab already appended the REST-confirmed row.
          return
        }
        if ((m.content == null || m.content === '') && m.sender_id !== userId) {
          if (pendingPullRef.current) return
          pendingPullRef.current = true
          try {
            const pending = await fetchPendingDeliveries(activeChatId)
            if (pending.length === 0) return
            const rows = await decryptApiMessageRows(
              unwrappedPrivateKey,
              cryptoCtx,
              pending,
              drCtx
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

        // Legacy/group path: message has content on the wire.
        let plaintext = ''
        if (m.content != null && m.iv != null && m.content !== '') {
          try {
            // v2 DR on non-fanout path (rare: WS broadcast of DR message)
            if (m.protocol_version === 2 && m.iv === DR_SLOT_SENTINEL && m.dr_header && drCtx) {
              const { decryptFromPeer } = await import('@/lib/ratchet/session-manager')
              plaintext = await decryptFromPeer(drCtx.ownerUserId, drCtx.peerUserId, {
                protocolVersion: 2,
                drHeader: m.dr_header,
                iv: DR_SLOT_SENTINEL,
                encrypted_content: m.content,
                drInit: m.dr_init ? JSON.parse(m.dr_init) : undefined,
              })
            } else {
              const { decryptInboundText } = await import('@/lib/chat-crypto')
              plaintext = await decryptInboundText(unwrappedPrivateKey, cryptoCtx, m.content, m.iv)
            }
          } catch {
            plaintext = '[DECRYPT_FAIL]'
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
        await cacheMessage(row)
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
    updateMessageReadAt,
    updateMessageReactions,
    userId,
  ])

  useEffect(() => {
    const id = window.setInterval(() => pruneTypingUsers(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pruneTypingUsers])
}

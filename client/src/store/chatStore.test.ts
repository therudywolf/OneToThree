import { beforeEach, describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/chat'
import { useChatStore } from './chatStore'

function message(partial: Partial<DecryptedMessage> & { id: string; chat_id: string; sender_id: string }): DecryptedMessage {
  return {
    id: partial.id,
    chat_id: partial.chat_id,
    sender_id: partial.sender_id,
    plaintext: partial.plaintext ?? 'x',
    created_at: partial.created_at ?? new Date().toISOString(),
    reply_to_id: partial.reply_to_id ?? null,
    media_path: null,
    media_type: null,
    media_iv: null,
    read_at: null,
    burn_at: null,
  }
}

describe('chatStore unread model', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    useChatStore.getState().setUserId('u-self')
  })

  it('tracks per-chat unread and aggregate total for background messages', () => {
    const store = useChatStore.getState()
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer',
      isForegroundVisible: false,
      isActiveChat: false,
    })

    const next = useChatStore.getState()
    expect(next.unreadByChat['chat-a']?.total).toBe(1)
    expect(next.unreadByChat['chat-a']?.mentions).toBe(0)
    expect(next.unreadTotal).toBe(1)
  })

  it('does not increase unread for own message or visible active chat', () => {
    const store = useChatStore.getState()

    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-self',
      isForegroundVisible: false,
      isActiveChat: false,
    })
    expect(useChatStore.getState().unreadTotal).toBe(0)

    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer',
      isForegroundVisible: true,
      isActiveChat: true,
    })
    expect(useChatStore.getState().unreadTotal).toBe(0)
  })

  it('counts thread and mention when replying to own message', () => {
    const store = useChatStore.getState()
    store.setMessages([
      message({ id: 'm-own', chat_id: 'chat-a', sender_id: 'u-self' }),
    ])
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer',
      replyToId: 'm-own',
      isForegroundVisible: false,
      isActiveChat: false,
    })

    const state = useChatStore.getState()
    expect(state.unreadByChat['chat-a']?.total).toBe(1)
    expect(state.unreadByChat['chat-a']?.mentions).toBe(1)
    expect(state.unreadByChat['chat-a']?.threads['m-own']).toBe(1)
  })

  it('clears unread for chat when opening chat', () => {
    const store = useChatStore.getState()
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer',
      isForegroundVisible: false,
      isActiveChat: false,
    })
    store.trackInboundUnread({
      chatId: 'chat-b',
      senderId: 'u-peer',
      isForegroundVisible: false,
      isActiveChat: false,
    })
    expect(useChatStore.getState().unreadTotal).toBe(2)

    store.setActiveChatId('chat-a')
    const next = useChatStore.getState()
    expect(next.unreadByChat['chat-a']).toBeUndefined()
    expect(next.unreadByChat['chat-b']?.total).toBe(1)
    expect(next.unreadTotal).toBe(1)
  })

  it('marks a thread as read and decreases aggregate unread', () => {
    const store = useChatStore.getState()
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer',
      replyToId: 'thread-1',
      isForegroundVisible: false,
      isActiveChat: false,
    })
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer2',
      replyToId: 'thread-1',
      isForegroundVisible: false,
      isActiveChat: false,
    })
    store.trackInboundUnread({
      chatId: 'chat-a',
      senderId: 'u-peer2',
      replyToId: 'thread-2',
      isForegroundVisible: false,
      isActiveChat: false,
    })

    expect(useChatStore.getState().unreadByChat['chat-a']?.total).toBe(3)
    store.markThreadRead('chat-a', 'thread-1')

    const next = useChatStore.getState()
    expect(next.unreadByChat['chat-a']?.threads['thread-1']).toBeUndefined()
    expect(next.unreadByChat['chat-a']?.threads['thread-2']).toBe(1)
    expect(next.unreadByChat['chat-a']?.total).toBe(1)
    expect(next.unreadTotal).toBe(1)
  })
})

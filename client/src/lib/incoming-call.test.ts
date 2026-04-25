import { describe, expect, it } from 'vitest'
import { buildCallLeaveMessage, upsertIncomingCall } from '@/lib/incoming-call'

describe('incoming call helpers', () => {
  it('preserves chat context when later signaling updates the same peer', () => {
    const merged = upsertIncomingCall(
      {
        peerId: 'peer-1',
        chatId: 'chat-1',
        isVideo: true,
        offer: null,
      },
      {
        peerId: 'peer-1',
        transport: 'webrtc',
        offer: { type: 'offer', sdp: 'v=0' },
      }
    )

    expect(merged.chatId).toBe('chat-1')
    expect(merged.isVideo).toBe(true)
    expect(merged.transport).toBe('webrtc')
    expect(merged.offer).toEqual({ type: 'offer', sdp: 'v=0' })
  })

  it('builds call_leave only when chat context exists', () => {
    expect(buildCallLeaveMessage(null)).toBeNull()
    expect(buildCallLeaveMessage({ peerId: 'peer-1' })).toBeNull()
    expect(buildCallLeaveMessage({ peerId: 'peer-1', chatId: 'chat-1' })).toEqual({
      type: 'call_leave',
      chat_id: 'chat-1',
    })
  })
})

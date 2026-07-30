/**
 * Regression coverage for group-call PRESENCE in LiveKit (SFU) mode.
 *
 * The bug: `joinGroupCall` handed the room to LiveKit and returned, never
 * sending `group_call:join` over the app WebSocket. That signal is the only
 * thing that makes the server tell the rest of the chat a call exists — the
 * join banner, the offline push, and the room bookkeeping all hang off it. So
 * in SFU mode the caller sat alone in a perfectly healthy room that nobody
 * else could see, let alone join. It stayed hidden because prod had
 * `livekit_enabled: false` (unreadable secret file), which routed every call
 * down the mesh path, and the mesh path does send the signal.
 *
 * The mirror-image half: now that the server DOES get our join, it answers
 * with a participant list. Acting on that in SFU mode would build a second,
 * parallel mesh to peers we already reach through the SFU and publish the
 * microphone twice — so the list must be ignored while LiveKit owns the media.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: Array<Record<string, unknown>> = []

const joinLiveKitCall = vi.fn(async (roomId: string, _isVideo: boolean) => {
  // Mirror what the real manager does to the store on a successful join.
  const { useGroupCallStore } = await import('@/store/groupCallStore')
  const store = useGroupCallStore.getState()
  store.setIsInGroupCall(true)
  store.setRoomId(roomId)
  store.setTransport('livekit')
  return true
})

vi.mock('@/lib/livekit-call-manager', () => ({
  joinLiveKitCall: (roomId: string, isVideo: boolean) => joinLiveKitCall(roomId, isVideo),
  leaveLiveKitCall: vi.fn(),
  toggleLiveKitMute: vi.fn(),
  toggleLiveKitVideo: vi.fn(),
  toggleLiveKitScreenShare: vi.fn(),
  startLiveKitScreenShare: vi.fn(),
  isLiveKitActive: () => true,
}))
vi.mock('@/lib/api/socket', () => ({
  getFmSocket: () => ({ send: (p: Record<string, unknown>) => { sent.push(p) } }),
}))
vi.mock('@/lib/ice-servers', () => ({
  getIceServers: vi.fn(async () => []),
  normalizeIceServers: (s: unknown) => s ?? [],
}))
vi.mock('@/lib/ice-relay-warning', () => ({ notifyIfIceStunOnlyOnce: vi.fn() }))
vi.mock('@/lib/api/users', () => ({ lookupUsers: vi.fn(async () => []) }))
vi.mock('@/lib/crypto', () => ({
  deriveSharedSecret: vi.fn(),
  decryptBytes: vi.fn(),
  encryptBytes: vi.fn(),
  importEcdhPublicKey: vi.fn(),
}))
vi.mock('@/lib/call-audio-relay', () => ({
  AudioRelayPlayer: class {},
  startAudioRelayCapture: vi.fn(),
}))
vi.mock('@/lib/media-devices', () => ({
  loadMediaPrefs: () => ({ lowBandwidth: false }),
  getUserMediaConstraints: () => ({ audio: true, video: true }),
}))

const fetchCallConfig = vi.fn(async () => ({
  media_mode: 'self_hosted',
  origin_safe: false,
  livekit_enabled: true,
  livekit_url: 'wss://lk.example.test',
  mesh_fallback_enabled: true,
  group_relay_enabled: false,
}))
vi.mock('@/lib/api/call', () => ({ fetchCallConfig: () => fetchCallConfig() }))

import {
  joinGroupCall,
  leaveGroupCall,
  handleParticipantList,
} from '@/lib/group-call-manager'
import { useGroupCallStore } from '@/store/groupCallStore'

const ROOM = 'room-abc'

beforeEach(() => {
  sent.length = 0
  const store = useGroupCallStore.getState()
  store.setIsInGroupCall(false)
  store.setRoomId(null)
  store.setLocalStream(null)
})

describe('group call presence in LiveKit mode', () => {
  it('announces the join over the app WebSocket', async () => {
    const ok = await joinGroupCall(ROOM, false)
    expect(ok).toBe(true)
    expect(joinLiveKitCall).toHaveBeenCalledWith(ROOM, false)
    // Without this the chat never learns a call started: no banner, no push,
    // and the server's room set stays empty, so nobody can ever join.
    expect(sent).toContainEqual({
      type: 'group_call:join',
      room_id: ROOM,
      is_video: false,
    })
  })

  it('ignores the server participant list instead of opening a parallel mesh', async () => {
    await joinGroupCall(ROOM, false)
    sent.length = 0
    // A local stream is present in SFU mode too (LiveKit publishes it), which is
    // exactly what would let the mesh path build peer connections here.
    useGroupCallStore.getState().setLocalStream({
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream)

    // RTCPeerConnection is not defined in this environment — the mesh path would
    // throw. Completing quietly IS the assertion.
    await expect(
      handleParticipantList(
        ROOM,
        [{ userId: 'peer-1', username: 'peer', isMuted: false, isVideoOff: false }],
        'me'
      )
    ).resolves.toBeUndefined()
    expect(sent.filter((m) => m.type === 'group_call:offer')).toHaveLength(0)
  })

  it('announces the leave so the banner clears for everyone else', async () => {
    await joinGroupCall(ROOM, false)
    sent.length = 0
    leaveGroupCall()
    expect(sent).toContainEqual({ type: 'group_call:leave', room_id: ROOM })
  })
})

/**
 * Regression coverage for the GROUP-call screen-share media path.
 *
 * The bug this guards against: starting screen-share in a group call also
 * turned the webcam on (the screen track was conflated with the camera track
 * via `getVideoTracks()[0]`). Screen-share must acquire ONLY getDisplayMedia
 * and must never enable or (re)acquire the camera — mirroring the now-correct
 * 1:1 path. These tests drive the real `group-call-manager` functions with a
 * fake media/WebRTC layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Module mocks (group-call-manager pulls in heavy/browser-only deps) ---

vi.mock('@/lib/livekit-call-manager', () => ({
  joinLiveKitCall: vi.fn(),
  leaveLiveKitCall: vi.fn(),
  toggleLiveKitMute: vi.fn(),
  toggleLiveKitVideo: vi.fn(),
  startLiveKitScreenShare: vi.fn(),
  // No active LiveKit room in these tests -> mesh path is exercised.
  isLiveKitActive: () => false,
}))
vi.mock('@/lib/api/socket', () => ({
  getFmSocket: () => ({ send: vi.fn() }),
}))
vi.mock('@/lib/ice-servers', () => ({
  getIceServers: vi.fn(async () => []),
  normalizeIceServers: (s: unknown) => s ?? [],
}))
vi.mock('@/lib/ice-relay-warning', () => ({ notifyIfIceStunOnlyOnce: vi.fn() }))
vi.mock('@/lib/api/call', () => ({ fetchCallConfig: vi.fn() }))
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
  loadMediaPrefs: () => ({
    lowBandwidth: false,
    camEffect: 'none',
    screenRes: '1080p',
    screenFps: '30',
    screenContent: 'auto',
  }),
  loadCamEffectImage: () => null,
  getUserMediaConstraints: () => ({ audio: true, video: true }),
  getDisplayMediaOptions: () => ({ video: true, audio: true }),
  applyScreenTrackSettings: vi.fn(),
  applyVoiceConstraintsToTrack: vi.fn(async () => false),
  getScreenShareMaxBitrateBps: () => 5_000_000,
  getScreenShareDegradationPreference: () => 'balanced',
}))
vi.mock('@/lib/voice-processing', () => ({
  upgradeLocalStreamAudio: vi.fn(async () => null),
  applyVoiceSettingsToActiveCalls: vi.fn(async () => {}),
}))

import {
  startGroupCallScreenShare,
  stopGroupCallScreenShare,
  toggleGroupCallVideo,
  isGroupCallScreenSharing,
  isGroupCallCameraOn,
  leaveGroupCall,
} from '@/lib/group-call-manager'
import { useGroupCallStore } from '@/store/groupCallStore'

// --- Fake media-stream / track / peer-connection layer ---

class FakeTrack {
  enabled = true
  readyState: 'live' | 'ended' = 'live'
  readonly stop = vi.fn(() => {
    this.stopped = true
    this.readyState = 'ended'
  })
  stopped = false
  onended: (() => void) | null = null
  constructor(public kind: 'audio' | 'video') {}
}

class FakeStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  /** Stable-ish id so msid bookkeeping has something to hold on to. */
  readonly id = `fake-${Math.random().toString(36).slice(2)}`
  getTracks() {
    return [...this.tracks]
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t)
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t)
  }
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  replaceTrack = vi.fn((t: FakeTrack | null) => {
    this.track = t
  })
}

class FakePeerConnection {
  senders: FakeSender[]
  constructor(initialTracks: FakeTrack[]) {
    this.senders = initialTracks.map((t) => new FakeSender(t))
  }
  getSenders() {
    return this.senders
  }
  addTrack(t: FakeTrack) {
    const sender = new FakeSender(t)
    this.senders.push(sender)
    return sender
  }
  removeTrack(sender: FakeSender) {
    this.senders = this.senders.filter((s) => s !== sender)
  }
  close = vi.fn()
}

/** Install a getDisplayMedia stub returning a fresh screen video track. */
function stubDisplayMedia(): FakeTrack {
  const screenTrack = new FakeTrack('video')
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: vi.fn(async () => new FakeStream([screenTrack])),
      getUserMedia: vi.fn(async () => {
        throw new Error('getUserMedia must NOT be called by screen-share')
      }),
    },
  })
  return screenTrack
}

/** Seed the group store as if a mesh group call is in progress. */
function seedMeshCall(localStream: FakeStream, peer?: FakePeerConnection) {
  // The dual screen-share path constructs `new MediaStream()` for the msid.
  vi.stubGlobal('MediaStream', FakeStream)
  const store = useGroupCallStore.getState()
  store.reset()
  store.setRoomId('room-1')
  store.setIsInGroupCall(true)
  store.setTransport('mesh')
  store.setLocalStream(localStream as unknown as MediaStream)
  if (peer) {
    store.addPeerConnection('peer-1', peer as unknown as RTCPeerConnection)
  }
}

afterEach(() => {
  // leaveGroupCall() -> cleanupAll() also clears the module-level camera/screen
  // track refs, so no media state leaks between tests.
  leaveGroupCall()
  useGroupCallStore.getState().reset()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('group-call screen-share — dual camera+screen, never touches the webcam', () => {
  it('starts screen-share on an audio-only call without acquiring the camera', async () => {
    const audio = new FakeTrack('audio')
    const local = new FakeStream([audio])
    const peer = new FakePeerConnection([audio])
    seedMeshCall(local, peer)
    const screenTrack = stubDisplayMedia()

    const ok = await startGroupCallScreenShare()

    expect(ok).toBe(true)
    expect(isGroupCallScreenSharing()).toBe(true)
    // getUserMedia (camera) was never called — the getDisplayMedia stub throws
    // from getUserMedia if it is. A camera was never acquired.
    expect(isGroupCallCameraOn()).toBe(false)
    // Dual mode: the screen does NOT enter the local (mic+camera) stream — it
    // gets its own preview stream and its own senders.
    expect(local.getVideoTracks()).toEqual([])
    const preview = useGroupCallStore.getState().localScreenStream
    expect(preview?.getVideoTracks()).toEqual([screenTrack])
    expect(screenTrack.enabled).toBe(true)
  })

  it('keeps a hard-stopped camera off while screen-sharing', async () => {
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeStream([camera])),
      },
    })
    await toggleGroupCallVideo() // ON (lazy acquire returns `camera`)
    await toggleGroupCallVideo() // OFF -> hard stop
    expect(camera.stopped).toBe(true)
    expect(isGroupCallCameraOn()).toBe(false)
    expect(local.getVideoTracks()).toEqual([])

    stubDisplayMedia()
    const ok = await startGroupCallScreenShare()

    expect(ok).toBe(true)
    // THE REGRESSION ASSERTION: screen-share must not resurrect the camera.
    expect(isGroupCallCameraOn()).toBe(false)
    expect(local.getVideoTracks()).toEqual([])
  })

  it('publishes the screen track onto peers without enabling the camera', async () => {
    const audio = new FakeTrack('audio')
    const local = new FakeStream([audio])
    const peer = new FakePeerConnection([audio])
    seedMeshCall(local, peer)
    const screenTrack = stubDisplayMedia()

    await startGroupCallScreenShare()

    // A video sender now carries the screen track on the peer connection.
    const videoSender = peer.getSenders().find((s) => s.track?.kind === 'video')
    expect(videoSender?.track).toBe(screenTrack)
  })

  it('leaves the live camera untouched through a share start/stop cycle', async () => {
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([camera])) },
    })
    await toggleGroupCallVideo() // ON — camera live during the share

    const screenTrack = stubDisplayMedia()
    await startGroupCallScreenShare()

    // BOTH videos published simultaneously: camera sender + screen sender.
    const videoSenders = peer.getSenders().filter((s) => s.track?.kind === 'video')
    expect(videoSenders.map((s) => s.track)).toEqual(
      expect.arrayContaining([camera, screenTrack])
    )

    stopGroupCallScreenShare()

    expect(isGroupCallScreenSharing()).toBe(false)
    // Camera never touched: still live, enabled, published, in localStream.
    const store = useGroupCallStore.getState()
    expect((store.localStream as unknown as FakeStream).getVideoTracks()).toEqual([
      camera,
    ])
    expect(camera.enabled).toBe(true)
    expect(camera.stopped).toBe(false)
    const remaining = peer.getSenders().filter((s) => s.track?.kind === 'video')
    expect(remaining.map((s) => s.track)).toEqual([camera])
    // Screen fully torn down.
    expect(screenTrack.stopped).toBe(true)
    expect(store.localScreenStream).toBeNull()
  })

  it('returns to no-video when the camera was hard-stopped before sharing', async () => {
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([camera])) },
    })
    await toggleGroupCallVideo() // ON
    await toggleGroupCallVideo() // OFF -> hard stop, no camera track remains

    const screenTrack = stubDisplayMedia()
    await startGroupCallScreenShare()
    stopGroupCallScreenShare()

    expect(isGroupCallScreenSharing()).toBe(false)
    const store = useGroupCallStore.getState()
    expect((store.localStream as unknown as FakeStream).getVideoTracks()).toEqual([])
    expect(isGroupCallCameraOn()).toBe(false)
    expect(screenTrack.stopped).toBe(true)
    // No video sender remains with a live track.
    const liveVideo = peer
      .getSenders()
      .filter((s) => s.track?.kind === 'video' && !(s.track as FakeTrack).stopped)
    expect(liveVideo).toEqual([])
  })
})

describe('group-call camera toggle — independent of the screen track', () => {
  it('stops the camera track, not the screen track, while screen-sharing', async () => {
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([camera])) },
    })
    await toggleGroupCallVideo() // camera ON
    expect(camera.enabled).toBe(true)

    const screenTrack = stubDisplayMedia()
    await startGroupCallScreenShare()

    // Toggle camera OFF while screen-sharing — hard off.
    await toggleGroupCallVideo()

    // The CAMERA track stopped; the SCREEN track stays live on its own sender.
    expect(camera.stopped).toBe(true)
    expect(isGroupCallCameraOn()).toBe(false)
    expect(screenTrack.enabled).toBe(true)
    expect(screenTrack.stopped).toBe(false)
    const liveVideo = peer
      .getSenders()
      .filter((s) => s.track?.kind === 'video' && !(s.track as FakeTrack).stopped)
    expect(liveVideo.map((s) => s.track)).toEqual([screenTrack])
  })
})

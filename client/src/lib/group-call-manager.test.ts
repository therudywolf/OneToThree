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
  loadMediaPrefs: () => ({ lowBandwidth: false }),
  getUserMediaConstraints: () => ({ audio: true, video: true }),
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
  readonly stop = vi.fn(() => {
    this.stopped = true
  })
  stopped = false
  onended: (() => void) | null = null
  constructor(public kind: 'audio' | 'video') {}
}

class FakeStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = [...tracks]
  }
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
    this.senders.push(new FakeSender(t))
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

describe('group-call screen-share — must NOT turn on the webcam', () => {
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
    // The local stream now carries the SCREEN track as its only video track.
    expect(local.getVideoTracks()).toEqual([screenTrack])
    expect(screenTrack.enabled).toBe(true)
  })

  it('leaves an already-off camera track disabled while screen-sharing', async () => {
    // Camera turned on then off before sharing — a disabled camera track exists.
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    // First flip the camera ON via the lazy path is not needed — simulate the
    // camera already being the published video track, then disabled.
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeStream([camera])),
      },
    })
    await toggleGroupCallVideo() // ON (lazy acquire returns `camera`)
    await toggleGroupCallVideo() // OFF
    expect(camera.enabled).toBe(false)
    expect(isGroupCallCameraOn()).toBe(false)

    const screenTrack = stubDisplayMedia()
    const ok = await startGroupCallScreenShare()

    expect(ok).toBe(true)
    // THE REGRESSION ASSERTION: screen-share must not flip the camera back on.
    expect(camera.enabled).toBe(false)
    expect(isGroupCallCameraOn()).toBe(false)
    // The camera track is detached (not stopped — state preserved for restore).
    expect(camera.stopped).toBe(false)
    expect(local.getVideoTracks()).toEqual([screenTrack])
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

  it('restores a disabled camera (still disabled) when screen-share stops', async () => {
    const audio = new FakeTrack('audio')
    const camera = new FakeTrack('video')
    const local = new FakeStream([audio, camera])
    const peer = new FakePeerConnection([audio, camera])
    seedMeshCall(local, peer)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([camera])) },
    })
    await toggleGroupCallVideo() // ON
    await toggleGroupCallVideo() // OFF -> camera.enabled === false

    stubDisplayMedia()
    await startGroupCallScreenShare()
    stopGroupCallScreenShare()

    expect(isGroupCallScreenSharing()).toBe(false)
    // Camera restored as the published video track, still disabled.
    const store = useGroupCallStore.getState()
    expect((store.localStream as unknown as FakeStream).getVideoTracks()).toEqual([
      camera,
    ])
    expect(camera.enabled).toBe(false)
  })

  it('clears video entirely when an audio-only call stops screen-sharing', async () => {
    const audio = new FakeTrack('audio')
    const local = new FakeStream([audio])
    const peer = new FakePeerConnection([audio])
    seedMeshCall(local, peer)
    const screenTrack = stubDisplayMedia()

    await startGroupCallScreenShare()
    stopGroupCallScreenShare()

    expect(isGroupCallScreenSharing()).toBe(false)
    // No camera ever existed -> back to audio-only, screen track stopped.
    expect(local.getVideoTracks()).toEqual([])
    expect(screenTrack.stopped).toBe(true)
    const videoSender = peer.getSenders().find((s) => s.track?.kind === 'video')
    expect(videoSender?.track ?? null).toBeNull()
  })
})

describe('group-call camera toggle — independent of the screen track', () => {
  it('flips the camera track, not the screen track, while screen-sharing', async () => {
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

    // Toggle camera OFF while screen-sharing.
    await toggleGroupCallVideo()

    // The CAMERA track flipped; the SCREEN track stays enabled (it owns video).
    expect(camera.enabled).toBe(false)
    expect(screenTrack.enabled).toBe(true)
  })
})

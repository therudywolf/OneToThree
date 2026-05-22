'use client'

/**
 * LiveKit SFU call manager.
 *
 * Replaces the P2P mesh for group calls when LiveKit is configured.
 * All media flows through the SFU server — no direct IP between participants.
 *
 * Uses LiveKit's built-in E2EE (Insertable Streams / AES-GCM) when the server
 * returns a call_e2ee_key. The key is a 32-byte HMAC-SHA256 per-session
 * secret shared among all participants in the room.
 */

import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type LocalParticipant,
  type LocalTrackPublication,
  ConnectionState,
  createLocalTracks,
  type RoomConnectOptions,
  ExternalE2EEKeyProvider,
} from 'livekit-client'
import { createCallToken } from '@/lib/api/call'
import { useGroupCallStore } from '@/store/groupCallStore'

let activeRoom: Room | null = null

/** Decode base64 (standard or url-safe) to Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(standard)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

/**
 * Build an ExternalE2EEKeyProvider from the raw base64 room key.
 * Returns null if the browser lacks SubtleCrypto or the key is absent.
 */
async function makeE2eeKeyProvider(
  rawB64: string | undefined
): Promise<ExternalE2EEKeyProvider | null> {
  if (!rawB64) return null
  try {
    const keyBytes = b64ToBytes(rawB64)
    const provider = new ExternalE2EEKeyProvider()
    // setKey accepts ArrayBuffer; shared room key for all tracks (no identity).
    await provider.setKey(keyBytes.buffer as ArrayBuffer)
    return provider
  } catch (err) {
    console.warn('[livekit] E2EE key setup failed — falling back to unencrypted SFU', err)
    return null
  }
}

function storeParticipantFromLk(
  p: RemoteParticipant | LocalParticipant,
  isSelf: boolean
) {
  const store = useGroupCallStore.getState()
  const userId = p.identity
  const existing = store.participants[userId]
  store.setParticipant(userId, {
    userId,
    username: p.name ?? p.identity,
    isMuted: isSelf
      ? !p.isMicrophoneEnabled
      : !(p as RemoteParticipant).isMicrophoneEnabled,
    isVideoOff: isSelf
      ? !p.isCameraEnabled
      : !(p as RemoteParticipant).isCameraEnabled,
    isSpeaking: existing?.isSpeaking ?? false,
    connectionState: 'pending',
  })
}

function buildRemoteStream(participant: RemoteParticipant): MediaStream | null {
  const tracks: MediaStreamTrack[] = []
  for (const pub of participant.trackPublications.values()) {
    if (pub.track?.mediaStreamTrack) {
      tracks.push(pub.track.mediaStreamTrack)
    }
  }
  if (tracks.length === 0) return null
  return new MediaStream(tracks)
}

function updateRemoteStream(participant: RemoteParticipant) {
  const stream = buildRemoteStream(participant)
  const store = useGroupCallStore.getState()
  if (stream) {
    store.setRemoteStream(participant.identity, stream)
  } else {
    store.removeRemoteStream(participant.identity)
  }
}

export async function joinLiveKitCall(
  roomId: string,
  isVideo: boolean
): Promise<boolean> {
  const store = useGroupCallStore.getState()
  if (store.isInGroupCall) return false

  let tokenResp: Awaited<ReturnType<typeof createCallToken>>
  try {
    tokenResp = await createCallToken(roomId)
  } catch {
    return false
  }

  // Wire E2EE if the server supplied a room key.
  const keyProvider = await makeE2eeKeyProvider(tokenResp.call_e2ee_key)

  const roomOptions: ConstructorParameters<typeof Room>[0] = {
    adaptiveStream: true,
    dynacast: true,
  }

  if (keyProvider) {
    // The E2EE worker was copied to /public by the postinstall script.
    roomOptions.e2ee = {
      keyProvider,
      worker: new Worker('/livekit-e2ee-worker.js'),
    }
  }

  const room = new Room(roomOptions)
  activeRoom = room

  // Set up event handlers before connecting
  room
    .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      storeParticipantFromLk(participant, false)
    })
    .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      store.removeParticipant(participant.identity)
      store.removeRemoteStream(participant.identity)
    })
    .on(
      RoomEvent.TrackSubscribed,
      (
        _track: unknown,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        updateRemoteStream(participant)
      }
    )
    .on(
      RoomEvent.TrackUnsubscribed,
      (
        _track: unknown,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        updateRemoteStream(participant)
      }
    )
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      // Reset all speaking flags then mark active speakers
      const current = store.participants
      for (const uid of Object.keys(current)) {
        if (current[uid]?.isSpeaking) {
          store.updateParticipant(uid, { isSpeaking: false })
        }
      }
      for (const s of speakers) {
        store.updateParticipant(s.identity, { isSpeaking: true })
      }
    })
    .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      const track = pub.track?.mediaStreamTrack
      if (!track) return
      const current = store.localStream
      const tracks = current ? current.getTracks() : []
      const filtered = tracks.filter(
        (t) =>
          (pub.kind === Track.Kind.Audio && t.kind !== 'audio') ||
          (pub.kind === Track.Kind.Video && t.kind !== 'video')
      )
      store.setLocalStream(new MediaStream([...filtered, track]))
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) {
        store.setIsScreenSharing(false)
      }
    })
    .on(RoomEvent.Disconnected, () => {
      store.reset()
      activeRoom = null
    })
    .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      if (state === ConnectionState.Connected) {
        // Seed participants from already-connected remotes
        for (const p of room.remoteParticipants.values()) {
          storeParticipantFromLk(p, false)
          updateRemoteStream(p)
        }
      }
    })

  try {
    const connectOpts: RoomConnectOptions = {}
    await room.connect(tokenResp.url, tokenResp.token, connectOpts)

    const localTracks = await createLocalTracks({
      audio: true,
      video: isVideo
        ? { resolution: { width: 1280, height: 720, frameRate: 30 } }
        : false,
    })

    const localStream = new MediaStream(
      localTracks.map((t) => t.mediaStreamTrack)
    )
    store.setLocalStream(localStream)

    await Promise.all(localTracks.map((t) => room.localParticipant.publishTrack(t)))
    storeParticipantFromLk(room.localParticipant, true)

    store.setIsInGroupCall(true)
    store.setRoomId(roomId)
    store.setIsVideo(isVideo)
    store.setTransport('livekit')
    if (keyProvider) {
      console.debug('[livekit] E2EE active for room', roomId)
    }
  } catch {
    await room.disconnect()
    activeRoom = null
    return false
  }

  return true
}

export function leaveLiveKitCall() {
  if (activeRoom) {
    void activeRoom.disconnect()
    activeRoom = null
  }
  useGroupCallStore.getState().reset()
}

export async function toggleLiveKitMute(): Promise<void> {
  if (!activeRoom) return
  const lp = activeRoom.localParticipant
  await lp.setMicrophoneEnabled(lp.isMicrophoneEnabled ? false : true)
  useGroupCallStore
    .getState()
    .updateParticipant(lp.identity, { isMuted: !lp.isMicrophoneEnabled })
}

export async function toggleLiveKitVideo(): Promise<void> {
  if (!activeRoom) return
  const lp = activeRoom.localParticipant
  await lp.setCameraEnabled(lp.isCameraEnabled ? false : true)
  useGroupCallStore
    .getState()
    .updateParticipant(lp.identity, { isVideoOff: !lp.isCameraEnabled })
}

export async function toggleLiveKitScreenShare(): Promise<boolean> {
  if (!activeRoom) return false
  const lp = activeRoom.localParticipant
  try {
    await lp.setScreenShareEnabled(!lp.isScreenShareEnabled)
  } catch {
    // Picker dismissed or the SFU rejected the track — report the real state.
  }
  return lp.isScreenShareEnabled
}

export function isLiveKitActive(): boolean {
  return activeRoom !== null
}

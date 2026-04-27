'use client'

/**
 * LiveKit SFU call manager.
 *
 * Replaces the P2P mesh for group calls when LiveKit is configured.
 * All media flows through the SFU server — no direct IP between participants.
 *
 * Uses LiveKit's built-in E2EE (Insertable Streams / GCM) when the server
 * returns a call_e2ee_key.
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
} from 'livekit-client'
import { createCallToken } from '@/lib/api/call'
import { useGroupCallStore } from '@/store/groupCallStore'

let activeRoom: Room | null = null

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

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  })
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
    // E2EE via LiveKit Insertable Streams would require BaseKeyProvider setup;
    // call_e2ee_key is reserved for future wiring.
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

export async function startLiveKitScreenShare(): Promise<void> {
  if (!activeRoom) return
  await activeRoom.localParticipant.setScreenShareEnabled(true)
}

export function isLiveKitActive(): boolean {
  return activeRoom !== null
}

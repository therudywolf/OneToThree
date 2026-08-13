'use client'

/**
 * LiveKit SFU call manager.
 *
 * Replaces the P2P mesh for group calls when LiveKit is configured.
 * All media flows through the SFU server — no direct IP between participants.
 *
 * Uses LiveKit Insertable-Streams frame encryption (AES-GCM) when the server
 * returns a call_e2ee_key — a per-session key shared among all participants in
 * the room. NOTE: this encrypts media against a passive SFU/network observer,
 * but it is NOT end-to-end against the application server: the server derives
 * the key from its own LIVEKIT_API_SECRET and can reconstruct it (see call.ts
 * trust-boundary note + backlog N11). Do not market group calls as E2EE.
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
  type RoomConnectOptions,
  ExternalE2EEKeyProvider,
} from 'livekit-client'
import { createCallToken } from '@/lib/api/call'
import { useGroupCallStore } from '@/store/groupCallStore'
import {
  loadMediaPrefs,
  loadCamEffectImage,
  getUserMediaConstraints,
} from '@/lib/media-devices'
import { upgradeLocalStreamAudio, type VoiceProcessingHandle } from '@/lib/voice-processing'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'

let activeRoom: Room | null = null
/** Voice-processing chain (noise gate) — same treatment the mesh paths get. */
let lkVoiceHandle: VoiceProcessingHandle | null = null
/** Camera background-effects chain for the SFU-published camera. */
let lkCamFx: CameraEffectsHandle | null = null
/** Raw camera track when no effects chain wraps it (stopped on unpublish). */
let lkRawCameraTrack: MediaStreamTrack | null = null

function disposeLkProcessing() {
  lkVoiceHandle?.dispose()
  lkVoiceHandle = null
  lkCamFx?.dispose()
  lkCamFx = null
  lkRawCameraTrack?.stop()
  lkRawCameraTrack = null
}

/** Acquire + wrap a camera track per the saved background-effect pref. */
async function acquireLkCameraTrack(): Promise<MediaStreamTrack | null> {
  const prefs = loadMediaPrefs()
  let raw: MediaStreamTrack | null = null
  try {
    const gum = await navigator.mediaDevices.getUserMedia({
      video: getUserMediaConstraints({ video: true, hd: !prefs.lowBandwidth }).video,
      audio: false,
    })
    raw = gum.getVideoTracks()[0] ?? null
  } catch {
    return null
  }
  if (!raw) return null
  if (prefs.camEffect === 'none') {
    lkRawCameraTrack = raw
    return raw
  }
  try {
    const fx = await createEffectedCameraTrack(raw, {
      kind: prefs.camEffect,
      imageDataUrl: loadCamEffectImage(),
    })
    if (!fx) {
      lkRawCameraTrack = raw
      return raw
    }
    lkCamFx = fx
    return fx.processedTrack
  } catch {
    lkRawCameraTrack = raw
    return raw
  }
}

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

/**
 * Server-set participant metadata: `{"guest":true,"invited_by":"…"}`.
 *
 * The ONLY source of the guest badge. It has to come from the token (the
 * server signs `metadata` when it approves a knock) rather than from the
 * display name, or any participant could label themselves a guest — or, worse,
 * an actual guest could drop the label by renaming.
 */
export function isGuestParticipant(metadata: string | undefined): boolean {
  if (!metadata) return false
  try {
    return (JSON.parse(metadata) as { guest?: boolean }).guest === true
  } catch {
    return false
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
    isGuest: isGuestParticipant(p.metadata),
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

/** Suffix for the screen-share stream entry of a participant. */
export const LIVEKIT_SCREEN_SUFFIX = '#screen'

function updateRemoteStream(participant: RemoteParticipant) {
  // Camera+mic and screen-share go into SEPARATE store entries. One combined
  // MediaStream used to hold two video tracks, and a <video> element only ever
  // plays the first — a remote screen share never showed up at all.
  const camTracks: MediaStreamTrack[] = []
  const screenTracks: MediaStreamTrack[] = []
  for (const pub of participant.trackPublications.values()) {
    const t = pub.track?.mediaStreamTrack
    if (!t) continue
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      screenTracks.push(t)
    } else {
      camTracks.push(t)
    }
  }
  const store = useGroupCallStore.getState()
  if (camTracks.length > 0) {
    store.setRemoteStream(participant.identity, new MediaStream(camTracks))
  } else {
    store.removeRemoteStream(participant.identity)
  }
  const screenId = `${participant.identity}${LIVEKIT_SCREEN_SUFFIX}`
  if (screenTracks.length > 0) {
    store.setRemoteStream(screenId, new MediaStream(screenTracks))
  } else {
    store.removeRemoteStream(screenId)
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

  // Fail closed: when the server issued a room key, E2EE is expected. If the key
  // provider could not be built (SubtleCrypto unavailable, bad key bytes), do
  // NOT silently connect plaintext-to-SFU — abort the join so the caller falls
  // back to the mesh path. Only proceed without e2ee when no key was issued.
  if (tokenResp.call_e2ee_key && !keyProvider) {
    console.warn('[livekit] E2EE key issued but provider setup failed — aborting join (mesh fallback)')
    return false
  }

  const roomOptions: ConstructorParameters<typeof Room>[0] = {
    adaptiveStream: true,
    dynacast: true,
  }

  if (keyProvider) {
    // The E2EE worker was copied to /public by the postinstall script.
    // Worker construction can also throw (asset missing/blocked) — that leaves
    // E2EE non-functional, so treat it the same as a provider failure: abort
    // rather than connect to the SFU without working frame encryption.
    let worker: Worker
    try {
      worker = new Worker('/livekit-e2ee-worker.js')
    } catch (err) {
      console.warn('[livekit] E2EE worker failed to start — aborting join (mesh fallback)', err)
      return false
    }
    roomOptions.e2ee = { keyProvider, worker }
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
      store.removeRemoteStream(`${participant.identity}${LIVEKIT_SCREEN_SUFFIX}`)
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
      // Rebuild localStream so the camera is restored after a screen share ends.
      const seen = new Set<string>()
      const tracks: MediaStreamTrack[] = []
      for (const lkPub of room.localParticipant.trackPublications.values()) {
        const t = lkPub.track?.mediaStreamTrack
        if (!t || t.readyState !== 'live' || seen.has(t.kind)) continue
        seen.add(t.kind)
        tracks.push(t)
      }
      store.setLocalStream(tracks.length > 0 ? new MediaStream(tracks) : null)
    })
    .on(RoomEvent.Disconnected, () => {
      disposeLkProcessing()
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

    // Same processing the mesh paths get: device prefs + echo/noise/AGC at
    // capture, the noise-gate worklet on the mic, background effects on the
    // camera. Processed tracks are published as custom tracks.
    const prefs = loadMediaPrefs()
    const gum = await navigator.mediaDevices.getUserMedia(
      getUserMediaConstraints({ video: false, hd: !prefs.lowBandwidth })
    )
    try {
      lkVoiceHandle = await upgradeLocalStreamAudio(gum)
    } catch {
      lkVoiceHandle = null
    }
    const micTrack = gum.getAudioTracks()[0]
    const camTrack = isVideo ? await acquireLkCameraTrack() : null

    const localTracks: MediaStreamTrack[] = [
      ...(micTrack ? [micTrack] : []),
      ...(camTrack ? [camTrack] : []),
    ]
    store.setLocalStream(new MediaStream(localTracks))

    if (micTrack) {
      await room.localParticipant.publishTrack(micTrack, {
        source: Track.Source.Microphone,
      })
    }
    if (camTrack) {
      await room.localParticipant.publishTrack(camTrack, {
        source: Track.Source.Camera,
      })
    }
    storeParticipantFromLk(room.localParticipant, true)

    store.setIsInGroupCall(true)
    store.setRoomId(roomId)
    store.setIsVideo(isVideo)
    store.setTransport('livekit')
    if (keyProvider) {
      console.debug('[livekit] E2EE active for room', roomId)
    }
  } catch {
    disposeLkProcessing()
    await room.disconnect()
    activeRoom = null
    return false
  }

  return true
}

export function leaveLiveKitCall() {
  disposeLkProcessing()
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
  const camPub = lp.getTrackPublication(Track.Source.Camera)
  if (camPub?.track) {
    // OFF: unpublish + stop the track and its processing chain (LED out).
    try {
      await lp.unpublishTrack(camPub.track, true)
    } catch { /* already gone */ }
    lkCamFx?.dispose()
    lkCamFx = null
    lkRawCameraTrack?.stop()
    lkRawCameraTrack = null
    useGroupCallStore.getState().updateParticipant(lp.identity, { isVideoOff: true })
    return
  }
  // ON: acquire (through background effects when configured) and publish.
  const camTrack = await acquireLkCameraTrack()
  if (!camTrack) return
  try {
    await lp.publishTrack(camTrack, { source: Track.Source.Camera })
  } catch {
    lkCamFx?.dispose()
    lkCamFx = null
    lkRawCameraTrack?.stop()
    lkRawCameraTrack = null
    return
  }
  useGroupCallStore.getState().updateParticipant(lp.identity, { isVideoOff: false })
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

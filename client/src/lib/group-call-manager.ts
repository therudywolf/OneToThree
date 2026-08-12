'use client'

/**
 * PROJECT 13 :: GROUP_CALL_MESH_MANAGER
 * Level: Transmission Layer (Full Mesh WebRTC)
 * Vibe: Clinical Steel / Terminal Noir
 *
 * Manages group media. In origin-safe Cloudflare orange-cloud deployments it
 * uses pairwise encrypted audio frames over the app WebSocket. In explicit
 * self-hosted mode it can still use LiveKit or the legacy mesh fallback.
 */

import { getFmSocket } from '@/lib/api/socket'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useCallStore } from '@/store/callStore'
import type { GroupCallParticipant as _GroupCallParticipant } from '@/store/groupCallStore'
import { getIceServers,
  normalizeIceServers,
} from '@/lib/ice-servers'
import { notifyIfIceStunOnlyOnce } from '@/lib/ice-relay-warning'
import { lookupUsers } from '@/lib/api/users'
import { KDF_CTX, deriveSharedSecret, decryptBytes, encryptBytes, importEcdhPublicKey } from '@/lib/crypto'
import { useSessionStore } from '@/store/sessionStore'
import { AudioRelayPlayer, startAudioRelayCapture, type AudioRelayCaptureController } from '@/lib/call-audio-relay'
// NOTE: `@/lib/livekit-call-manager` statically imports the heavy `livekit-client`
// package. To keep that out of the main chat bundle for every user (D9), it is
// imported dynamically only inside the LiveKit-gated paths below. The sync
// "is LiveKit active?" check is tracked locally via `livekitActive` so the
// teardown / toggle paths don't need to statically pull the module in.
type LiveKitCallManager = typeof import('@/lib/livekit-call-manager')
function loadLiveKitManager(): Promise<LiveKitCallManager> {
  return import('@/lib/livekit-call-manager')
}
/** Local mirror of livekit-call-manager's active-room state (D9). */
let livekitActive = false
import { fetchCallConfig } from '@/lib/api/call'
import { applyVideoTrack, tuneScreenShareSender } from '@/lib/call-media-tracks'
import {
  getUserMediaConstraints,
  loadMediaPrefs,
  loadCamEffectImage,
  getDisplayMediaOptions,
  applyScreenTrackSettings,
  getScreenShareMaxBitrateBps,
  getScreenShareDegradationPreference,
} from '@/lib/media-devices'
import { mungeOpusStereo } from '@/lib/sdp-munge'
import { upgradeLocalStreamAudio, type VoiceProcessingHandle } from '@/lib/voice-processing'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'



async function resolveIceServers(): Promise<RTCIceServer[]> {
  const servers = await getIceServers()
  notifyIfIceStunOnlyOnce()
  return normalizeIceServers(servers)
}

function terminateFeed(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => {
    t.enabled = false
    t.stop()
  })
}

/** Pending ICE candidates queued before remote description is set. */
const pendingIce = new Map<string, RTCIceCandidateInit[]>()

/** Disconnect timers for peer connections. */
const disconnectTimers = new Map<string, number>()

/** Peers whose first offer is sent explicitly instead of relying on negotiationneeded. */
const pendingInitialOffers = new Set<string>()

/** Audio analysers for speaking detection. */
const audioAnalysers = new Map<string, { analyser: AnalyserNode; context: AudioContext; interval: number }>()

/** Cached ICE servers for this session. */
let cachedIceServers: RTCIceServer[] | null = null
let groupRelayMode = false
const relayPlayers = new Map<string, AudioRelayPlayer>()
const relayCaptures = new Map<string, AudioRelayCaptureController>()
const relayKeys = new Map<string, Promise<CryptoKey | null>>()

/**
 * Camera vs screen tracks are kept as distinct module refs so the two media
 * sources are never conflated — the same invariant the 1:1 path enforces via
 * `cameraFeedRef`/`screenFeedRef`. `groupCameraTrack` is the getUserMedia camera
 * video track (null until the user opts into video — a group call starts
 * audio-only); `groupScreenTrack` is the getDisplayMedia track while
 * screen-sharing. Screen-share must never enable or (re)acquire the camera.
 */
let groupCameraTrack: MediaStreamTrack | null = null
let groupScreenTrack: MediaStreamTrack | null = null
/** Screen-share audio track, tracked so the in-app stop / call teardown stops
 * and unpublishes it — not only the video track. */
let groupScreenAudioTrack: MediaStreamTrack | null = null
/** Per-peer RTP senders carrying the screen, so stop removes exactly them. */
const groupScreenSenders = new Map<string, { video: RTCRtpSender; audio?: RTCRtpSender }>()
/** Announced screen msid per REMOTE participant. */
const groupRemoteScreenStreamIds = new Map<string, string>()
/** Live mic-processing chain (noise gate) for the mesh/relay group call. */
let groupVoiceHandle: VoiceProcessingHandle | null = null

async function attachGroupVoiceChain(stream: MediaStream): Promise<void> {
  groupVoiceHandle?.dispose()
  groupVoiceHandle = null
  try {
    groupVoiceHandle = await upgradeLocalStreamAudio(stream)
  } catch {
    groupVoiceHandle = null
  }
}

/** Live camera-effects chain (background blur/replacement) for the mesh call.
 * When active, `groupCameraTrack` holds the PROCESSED track and this handle
 * owns the raw hardware one. */
let groupCamFx: CameraEffectsHandle | null = null

/** Wrap a raw camera track per the saved pref; returns the track to publish. */
async function wrapGroupCameraTrack(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
  groupCamFx?.dispose()
  groupCamFx = null
  const prefs = loadMediaPrefs()
  if (prefs.camEffect === 'none') return raw
  try {
    const handle = await createEffectedCameraTrack(raw, {
      kind: prefs.camEffect,
      imageDataUrl: loadCamEffectImage(),
    })
    if (!handle) return raw
    groupCamFx = handle
    return handle.processedTrack
  } catch {
    return raw
  }
}

/** Stop the published camera track AND its effects chain (raw included). */
function stopGroupCameraTrack(published: MediaStreamTrack | null): void {
  if (groupCamFx) {
    groupCamFx.dispose()
    groupCamFx = null
  }
  published?.stop()
}

/** Whether the local user is currently screen-sharing in the mesh call. */
export function isGroupCallScreenSharing(): boolean {
  return groupScreenTrack !== null
}

/**
 * Whether a camera track currently exists AND is enabled. Tracks the *camera*
 * specifically — independent of the screen track — so the in-call camera
 * control never reads the screen track as "camera on".
 */
export function isGroupCallCameraOn(): boolean {
  return groupCameraTrack !== null && groupCameraTrack.enabled
}

async function ensureIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers
  cachedIceServers = await resolveIceServers()
  return cachedIceServers
}

function sendGroupCallSignal(payload: object) {
  getFmSocket().send(payload)
}

/**
 * Bind each group relay frame to its room, direction and position.
 *
 * The 1:1 relay got this treatment already; this path did not, and it is the
 * same primitive with the same weakness: AES-GCM over a bare PCM buffer proves
 * only "someone with the key made this", so a captured frame replayed verbatim
 * — or fed back out of order — decrypts and PLAYS. Binding room, sender,
 * recipient and sequence into the AAD makes every one of those fail the tag.
 */
function groupRelayFrameAad(
  roomId: string,
  fromId: string,
  toId: string,
  seq: number
): Uint8Array {
  return new TextEncoder().encode(`p13:group-relay:v1|${roomId}|${fromId}|${toId}|${seq}`)
}

/** Outbound/inbound frame counters, per peer. Reset when the peer is dropped. */
const relaySeqOut = new Map<string, number>()
const relaySeqIn = new Map<string, number>()

async function resolveRelaySharedKey(
  peerId: string,
  roomId: string
): Promise<CryptoKey | null> {
  const cached = relayKeys.get(peerId)
  if (cached) return cached
  const task = (async () => {
    const ownPrivateKey = useSessionStore.getState().unwrappedPrivateKey
    if (!ownPrivateKey) return null
    const [peer] = await lookupUsers([peerId])
    if (!peer?.ecdh_public_key_jwk) return null
    const peerPublicKey = await importEcdhPublicKey(peer.ecdh_public_key_jwk)
    // #34: group-call relay derives under the call domain (see use-webrtc).
    // The ROOM is folded in as well, so two people who talk in several groups
    // do not protect every one of them with the same static pairwise secret.
    return deriveSharedSecret(ownPrivateKey, peerPublicKey, `${KDF_CTX.CALL}|${roomId}`)
  })().catch(() => null)
  relayKeys.set(peerId, task)
  return task
}

function ensureRelayPlayer(peerId: string): AudioRelayPlayer {
  const existing = relayPlayers.get(peerId)
  if (existing) return existing
  const player = new AudioRelayPlayer()
  relayPlayers.set(peerId, player)
  useGroupCallStore.getState().setRemoteStream(peerId, player.stream)
  return player
}

function stopRelayPeer(peerId: string) {
  relayCaptures.get(peerId)?.stop()
  relayCaptures.delete(peerId)
  relayPlayers.get(peerId)?.stop()
  relayPlayers.delete(peerId)
  relayKeys.delete(peerId)
  // Drop the counters with the key. A stale inbound high-water mark would
  // silently swallow the first frames of the next call with this peer.
  relaySeqOut.delete(peerId)
  relaySeqIn.delete(peerId)
}

async function startRelayCaptureForPeer(peerId: string): Promise<boolean> {
  const store = useGroupCallStore.getState()
  if (!groupRelayMode || !store.roomId || !store.localStream) return false
  if (relayCaptures.has(peerId)) return true

  const callRoomId = store.roomId
  const myUserId = useSessionStore.getState().userId
  if (!myUserId) return false
  const sharedKey = await resolveRelaySharedKey(peerId, callRoomId)
  if (!sharedKey) return false

  let busy = false
  const capture = await startAudioRelayCapture(store.localStream, ({ sampleRate, pcm }) => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        // Bail if the room moved under us: `sharedKey` is bound to the room we
        // started in, so a frame stamped with a newer room id would be sealed
        // under a key the recipient cannot derive. The capture is torn down on
        // leave anyway — this closes the window before that lands.
        const roomId = useGroupCallStore.getState().roomId
        if (roomId !== callRoomId) return
        const seq = (relaySeqOut.get(peerId) ?? 0) + 1
        relaySeqOut.set(peerId, seq)
        const encrypted = await encryptBytes(
          sharedKey,
          pcm,
          groupRelayFrameAad(roomId, myUserId, peerId, seq)
        )
        sendGroupCallSignal({
          type: 'group_call:relay_frame',
          room_id: roomId,
          target_user_id: peerId,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          sample_rate: sampleRate,
          seq,
        })
      } finally {
        busy = false
      }
    })()
  })
  relayCaptures.set(peerId, capture)
  return true
}

async function sendGroupOffer(
  roomId: string,
  peerId: string,
  pc: RTCPeerConnection,
  options?: RTCOfferOptions
): Promise<void> {
  if (pc.signalingState !== 'stable') return
  const store = useGroupCallStore.getState()
  const offer = await pc.createOffer(options)
  // Opus stereo + bitrate ceiling for screen-share audio (see sdp-munge.ts).
  offer.sdp = mungeOpusStereo(offer.sdp ?? '')
  await pc.setLocalDescription(offer)
  sendGroupCallSignal({
    type: 'group_call:offer',
    room_id: roomId,
    target_user_id: peerId,
    sdp: offer.sdp ?? '',
    is_video: store.isVideo,
  })
}

/** Create and wire up a peer connection for a specific user in the group call. */
function createPeerConnection(
  roomId: string,
  peerId: string,
  localStream: MediaStream,
  iceServers: RTCIceServer[]
): RTCPeerConnection {
  const store = useGroupCallStore.getState()
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' })

  // Add local tracks
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream))

  // ICE candidate handler
  pc.onicecandidate = (ev) => {
    sendGroupCallSignal({
      type: 'group_call:ice',
      room_id: roomId,
      target_user_id: peerId,
      candidate: ev.candidate ? ev.candidate.toJSON() : null,
    })
  }

  // Remote track handler
  pc.ontrack = (ev) => {
    const store2 = useGroupCallStore.getState()
    // The peer's announced screen msid routes into a SEPARATE tile entry.
    const screenSid = groupRemoteScreenStreamIds.get(peerId)
    if (ev.streams[0] && screenSid && ev.streams[0].id === screenSid) {
      store2.setRemoteStream(`${peerId}#screen`, ev.streams[0])
      return
    }
    if (ev.streams[0]) {
      store2.setRemoteStream(peerId, ev.streams[0])
      setupSpeakingDetection(peerId, ev.streams[0])
      return
    }
    // No msid (replaceTrack on a reused transceiver — e.g. screen share from a
    // camera-less peer). Merge into the peer's stream under a NEW identity.
    const current = store2.remoteStreams[peerId]
    const tracks = current ? current.getTracks().filter((t) => t !== ev.track) : []
    const merged = new MediaStream([...tracks, ev.track])
    store2.setRemoteStream(peerId, merged)
    setupSpeakingDetection(peerId, merged)
  }

  // Connection state monitoring
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState
    useGroupCallStore.getState().updateParticipant(peerId, { connectionState: state })

    if (state === 'connected' || state === 'completed') {
      const timer = disconnectTimers.get(peerId)
      if (timer) {
        clearTimeout(timer)
        disconnectTimers.delete(peerId)
      }
      // Also cancel a pending purge timer from a prior disconnect, so a peer that
      // flaps disconnected->connected->disconnected isn't torn down by a stale
      // purge timer mid-reconnect (mirrors the 1:1 hook). Without this only
      // cleanupPeer clears the `_purge` key.
      const purge = disconnectTimers.get(`${peerId}_purge`)
      if (purge) {
        clearTimeout(purge)
        disconnectTimers.delete(`${peerId}_purge`)
      }
    } else if (state === 'failed') {
      console.warn(`[GC.ICE] Connection failed to ${peerId.slice(0, 8)}, attempting restart`)
      try {
        pc.restartIce()
        void sendGroupOffer(roomId, peerId, pc, { iceRestart: true })
      } catch {
        cleanupPeer(peerId)
      }
    } else if (state === 'disconnected') {
      const timer = window.setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          const purgeTimer = window.setTimeout(() => {
            if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
              cleanupPeer(peerId)
            }
          }, 5000)
          disconnectTimers.set(`${peerId}_purge`, purgeTimer)
        }
      }, 4000)
      disconnectTimers.set(peerId, timer)
    } else if (state === 'closed') {
      cleanupPeer(peerId)
    }
  }

  // Negotiation needed (for polite peer)
  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') return
    if (pendingInitialOffers.has(peerId)) return
    try {
      await sendGroupOffer(roomId, peerId, pc)
    } catch (err) {
      console.error('[GC.SIGNAL] Negotiation failure:', err)
    }
  }

  store.addPeerConnection(peerId, pc)
  return pc
}

/** Set up audio analyser for speaking detection on a remote stream. */
function setupSpeakingDetection(peerId: string, stream: MediaStream) {
  cleanupSpeakingDetection(peerId)

  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return

  try {
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)

    const data = new Uint8Array(analyser.frequencyBinCount)
    const interval = window.setInterval(() => {
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      const isSpeaking = avg > 20
      const current = useGroupCallStore.getState().participants[peerId]
      if (current && current.isSpeaking !== isSpeaking) {
        useGroupCallStore.getState().updateParticipant(peerId, { isSpeaking })
      }
    }, 100)

    audioAnalysers.set(peerId, { analyser, context, interval })
  } catch (err) {
    console.warn('[GC.AUDIO] Speaking detection setup failed for', peerId.slice(0, 8), err)
  }
}

/** Clean up speaking detection for a peer. */
function cleanupSpeakingDetection(peerId: string) {
  const entry = audioAnalysers.get(peerId)
  if (!entry) return
  clearInterval(entry.interval)
  void entry.context.close().catch(() => {})
  audioAnalysers.delete(peerId)
}

/**
 * Reconcile the peer's remote MediaStream with the pc's live RECEIVERS after
 * an SDP exchange — renegotiation reusing a transceiver does not reliably
 * re-fire ontrack, and replaceTrack'd senders ship no msid (mirrors the 1:1
 * hook's syncRemoteFromReceivers).
 */
function syncRemoteFromReceivers(peerId: string, pc: RTCPeerConnection) {
  const receiving: MediaStreamTrack[] = []
  for (const tr of pc.getTransceivers()) {
    const dir = tr.currentDirection
    if (!dir || dir === 'inactive' || dir === 'stopped' || dir === 'sendonly') continue
    const track = tr.receiver?.track
    if (track && track.readyState === 'live') receiving.push(track)
  }
  if (receiving.length === 0) return
  const store = useGroupCallStore.getState()
  // Tracks already routed into the peer's SCREEN entry stay out of the main one.
  const screenEntry = store.remoteStreams[`${peerId}#screen`]
  const screenTracks = new Set(screenEntry ? screenEntry.getTracks() : [])
  const wanted = receiving.filter((t) => !screenTracks.has(t))
  if (wanted.length === 0) return
  const current = store.remoteStreams[peerId]
  const curTracks = current ? current.getTracks() : []
  const missing = wanted.filter((t) => !curTracks.includes(t))
  if (missing.length === 0) return
  const merged = new MediaStream([
    ...curTracks.filter((t) => t.readyState === 'live'),
    ...missing,
  ])
  store.setRemoteStream(peerId, merged)
  setupSpeakingDetection(peerId, merged)
}

/** Flush pending ICE candidates for a peer. */
async function flushIceQueue(peerId: string, pc: RTCPeerConnection) {
  const queue = pendingIce.get(peerId)
  if (!queue?.length) return
  const snapshot = [...queue]
  pendingIce.set(peerId, [])
  await Promise.all(
    snapshot.map(async (c) => {
      try {
        if (c) await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (e) {
        console.error(`[GC.ICE] Injection failure for ${peerId.slice(0, 8)}`, e)
      }
    })
  )
}

/** Clean up a single peer's connection and state. */
function cleanupPeer(peerId: string) {
  const store = useGroupCallStore.getState()

  // Clean timers
  const timer = disconnectTimers.get(peerId)
  if (timer) clearTimeout(timer)
  disconnectTimers.delete(peerId)
  const purgeTimer = disconnectTimers.get(`${peerId}_purge`)
  if (purgeTimer) clearTimeout(purgeTimer)
  disconnectTimers.delete(`${peerId}_purge`)

  // Clean speaking detection
  cleanupSpeakingDetection(peerId)
  stopRelayPeer(peerId)

  // Close peer connection
  const pc = store.peerConnections[peerId]
  if (pc) {
    pc.close()
    store.removePeerConnection(peerId)
  }

  // Clean remote stream(s) — the dedicated screen entry too.
  const remote = store.remoteStreams[peerId]
  if (remote) terminateFeed(remote)
  store.removeRemoteStream(peerId)
  store.removeRemoteStream(`${peerId}#screen`)
  groupRemoteScreenStreamIds.delete(peerId)
  groupScreenSenders.delete(peerId)

  // Remove participant
  store.removeParticipant(peerId)

  // Clean pending ICE
  pendingIce.delete(peerId)
}

/** Clean up everything — leave call completely. */
function cleanupAll() {
  const store = useGroupCallStore.getState()

  // Leave the room via signaling
  if (store.roomId) {
    sendGroupCallSignal({ type: 'group_call:leave', room_id: store.roomId })
  }

  // Clean up all peers
  for (const peerId of Object.keys(store.peerConnections)) {
    cleanupPeer(peerId)
  }
  for (const peerId of Array.from(new Set([...relayPlayers.keys(), ...relayCaptures.keys()]))) {
    stopRelayPeer(peerId)
  }
  // Belt and braces: the loop above only reaches peers that got as far as a
  // player or a capture. Receiving a frame derives the key BEFORE the player
  // exists, so a sender whose frames never decrypt leaves an orphan entry — and
  // since the key is now bound to the ROOM, carrying it into the next call
  // would make every frame there fail to open. Leaving ends every relay
  // relationship, so drop the lot.
  relayKeys.clear()
  relaySeqOut.clear()
  relaySeqIn.clear()

  // Stop the screen track(s) (if sharing) and local stream.
  groupScreenTrack?.stop()
  groupScreenAudioTrack?.stop()
  // Release the mic + camera-effects chains — they own the RAW hardware
  // tracks (terminateFeed below only reaches the processed tracks in
  // localStream).
  groupVoiceHandle?.dispose()
  groupVoiceHandle = null
  groupCamFx?.dispose()
  groupCamFx = null
  groupCameraTrack?.stop()
  terminateFeed(store.localStream)
  groupCameraTrack = null
  groupScreenTrack = null
  groupScreenAudioTrack = null
  groupScreenSenders.clear()
  groupRemoteScreenStreamIds.clear()

  // Clear cached ICE servers
  cachedIceServers = null
  groupRelayMode = false

  // Reset store
  store.reset()
  // Deafen is a shared call flag (callStore) — clear it so the next call isn't
  // silently started deafened.
  useCallStore.getState().setDeafened(false)
}

async function joinGroupAudioRelayCall(roomId: string): Promise<boolean> {
  const store = useGroupCallStore.getState()
  let stream: MediaStream
  try {
    // Honor the mic device + echo/noise/AGC prefs (was a bare `audio: true`).
    stream = await navigator.mediaDevices.getUserMedia(
      getUserMediaConstraints({ video: false, hd: false })
    )
  } catch (err) {
    console.error('[GC.RELAY] Failed to get audio media:', err)
    return false
  }
  await attachGroupVoiceChain(stream)

  groupRelayMode = true
  store.setLocalStream(stream)
  store.setIsInGroupCall(true)
  store.setRoomId(roomId)
  store.setIsVideo(false)
  store.setTransport('audio_relay')

  sendGroupCallSignal({
    type: 'group_call:join',
    room_id: roomId,
    is_video: false,
  })

  return true
}

// --- Public API ---

/** Join a group call room. Uses LiveKit SFU when available, mesh WebRTC as fallback. */
export async function joinGroupCall(
  roomId: string,
  isVideo: boolean
): Promise<boolean> {
  const store = useGroupCallStore.getState()
  if (store.isInGroupCall) return false

  // In origin-safe orange-cloud mode, do not advertise self-hosted LiveKit/coturn.
  // Group calls run as E2E pairwise encrypted audio over the existing WebSocket.
  try {
    const cfg = await fetchCallConfig()
    if (cfg.origin_safe || cfg.group_relay_enabled) {
      return joinGroupAudioRelayCall(roomId)
    }
    if (cfg.livekit_enabled && cfg.livekit_url) {
      const lk = await loadLiveKitManager()
      const ok = await lk.joinLiveKitCall(roomId, isVideo)
      if (ok) {
        livekitActive = true
        // PRESENCE still rides the app WebSocket, even though MEDIA does not.
        // The SFU knows who is in its room, but our server is what tells the
        // rest of the chat that a call is happening: the join banner, the
        // offline push, and the room bookkeeping all hang off this signal.
        // Without it a LiveKit call is invisible to everyone not already in it
        // — nobody can ever be the second participant, which makes a group call
        // useless in exactly the mode meant to carry the big ones.
        sendGroupCallSignal({
          type: 'group_call:join',
          room_id: roomId,
          is_video: isVideo,
        })
        return true
      }
    }
    if (cfg.mesh_fallback_enabled === false) return false
  } catch {
    return joinGroupAudioRelayCall(roomId)
  }

  // Mesh WebRTC fallback
  let stream: MediaStream
  try {
    const prefs = loadMediaPrefs()
    stream = await navigator.mediaDevices.getUserMedia(
      getUserMediaConstraints({ video: isVideo, hd: !prefs.lowBandwidth })
    )
  } catch (err) {
    console.error('[GC.MEDIA] Failed to get media:', err)
    return false
  }
  await attachGroupVoiceChain(stream)

  // Remember the camera track so screen-share can detach (never stop) it and
  // restore it afterwards — distinct from the screen track. Background
  // effects wrap the raw track before anything is published.
  const rawCam = stream.getVideoTracks()[0] ?? null
  if (rawCam) {
    const published = await wrapGroupCameraTrack(rawCam)
    if (published !== rawCam) {
      stream.removeTrack(rawCam)
      stream.addTrack(published)
    }
    groupCameraTrack = published
  } else {
    groupCameraTrack = null
  }

  store.setLocalStream(stream)
  store.setIsInGroupCall(true)
  store.setRoomId(roomId)
  store.setIsVideo(isVideo)
  store.setTransport('mesh')

  sendGroupCallSignal({
    type: 'group_call:join',
    room_id: roomId,
    is_video: isVideo,
  })

  return true
}

/** Leave the current group call. */
export function leaveGroupCall() {
  if (livekitActive) {
    livekitActive = false
    // Symmetric with the join above: the server drops us from the room, updates
    // everyone's banner count, and emits `group_call:ended` when we were the
    // last one out. Relying on the socket closing instead would leave a phantom
    // "call in progress" banner up for every other member until the tab is.
    const roomId = useGroupCallStore.getState().roomId
    if (roomId) sendGroupCallSignal({ type: 'group_call:leave', room_id: roomId })
    void loadLiveKitManager().then((lk) => lk.leaveLiveKitCall())
  } else {
    cleanupAll()
  }
}

/** Handle incoming participant list (received after joining). Create offers to all existing participants. */
export async function handleParticipantList(
  roomId: string,
  participants: Array<{
    userId: string
    username: string
    isMuted: boolean
    isVideoOff: boolean
  }>,
  myUserId: string
) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return

  // LiveKit owns the media. We now send `group_call:join` in SFU mode too (for
  // presence), so the server answers with a participant list here as well —
  // but acting on it would open a second, parallel mesh to peers we are already
  // connected to through the SFU, publishing the microphone twice. The LiveKit
  // manager populates the participant store from room events instead.
  if (livekitActive) return

  const iceServers = groupRelayMode ? [] : await ensureIceServers()

  for (const p of participants) {
    if (p.userId === myUserId) continue

    // Set participant state
    store.setParticipant(p.userId, {
      userId: p.userId,
      username: p.username,
      isMuted: p.isMuted,
      isVideoOff: p.isVideoOff,
      isSpeaking: false,
      connectionState: 'new',
    })

    if (groupRelayMode) {
      void startRelayCaptureForPeer(p.userId)
      continue
    }

    // Create peer connection and send offer
    if (store.localStream) {
      pendingInitialOffers.add(p.userId)
      const pc = createPeerConnection(roomId, p.userId, store.localStream, iceServers)
      void sendGroupOffer(roomId, p.userId, pc)
        .catch((err) => {
          console.error('[GC.SIGNAL] Initial offer failure:', err)
        })
        .finally(() => {
          pendingInitialOffers.delete(p.userId)
        })
    }
  }
}

/** Handle a new member joining the call room. */
export function handleMemberJoin(roomId: string, userId: string, username: string) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return

  // In SFU mode the ROOM is authoritative about who is in the call: the LiveKit
  // manager maintains the participant map from `ParticipantConnected`, with the
  // real mute/camera state attached. Writing a defaults-filled entry from the
  // WS signal would race it and show a muted peer as unmuted until their next
  // toggle. These signals reach us at all only because we now announce the join
  // for presence — they are not meant to drive the call UI.
  if (livekitActive) return

  store.setParticipant(userId, {
    userId,
    username,
    isMuted: false,
    isVideoOff: false,
    isSpeaking: false,
    connectionState: 'pending',
  })

  if (groupRelayMode) {
    void startRelayCaptureForPeer(userId)
  }

  // The new member will send us an offer; we wait for it.
}

/** Handle a member leaving the call room. */
export function handleMemberLeave(roomId: string, userId: string) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  // Same reasoning as handleMemberJoin: `ParticipantDisconnected` from the SFU
  // is what ends a peer's presence in SFU mode. Acting on the WS signal would
  // tear down a tile whose media is still arriving if the peer's app socket
  // merely blipped.
  if (livekitActive) return
  cleanupPeer(userId)
}

/** Handle incoming WebRTC offer from another participant. */
export async function handleGroupCallOffer(
  roomId: string,
  fromUserId: string,
  sdp: string,
  _isVideo: boolean
) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId || !store.localStream) return
  if (groupRelayMode) return

  let pc = store.peerConnections[fromUserId]

  if (!pc) {
    const iceServers = await ensureIceServers()
    pc = createPeerConnection(roomId, fromUserId, store.localStream, iceServers)
  }

  // Perfect negotiation for offer glare: when two participants enable camera
  // within ~1 RTT both renegotiate and send an offer at once, leaving both PCs
  // in 'have-local-offer'. A bare setRemoteDescription(offer) in a non-stable
  // state throws InvalidStateError and the catch below tears the peer down
  // (cleanupPeer), dropping that participant. The IMPOLITE peer ignores the
  // colliding offer (its own wins); the POLITE peer rolls its local offer back
  // then accepts. Mirrors the 1:1 path in use-webrtc.ts.
  const myUserId = useSessionStore.getState().userId
  const polite = !!myUserId && myUserId < fromUserId
  const offerCollision = pc.signalingState !== 'stable'
  if (offerCollision && !polite) return

  try {
    if (offerCollision) await pc.setLocalDescription({ type: 'rollback' })
    await pc.setRemoteDescription({ type: 'offer', sdp })
    await flushIceQueue(fromUserId, pc)
    const answer = await pc.createAnswer()
    answer.sdp = mungeOpusStereo(answer.sdp ?? '')
    await pc.setLocalDescription(answer)
    sendGroupCallSignal({
      type: 'group_call:answer',
      room_id: roomId,
      target_user_id: fromUserId,
      sdp: answer.sdp ?? '',
    })
    syncRemoteFromReceivers(fromUserId, pc)
  } catch (err) {
    console.error(`[GC.SIGNAL] Failed to handle offer from ${fromUserId.slice(0, 8)}:`, err)
    cleanupPeer(fromUserId)
  }
}

/** Handle incoming WebRTC answer from another participant. */
export async function handleGroupCallAnswer(
  roomId: string,
  fromUserId: string,
  sdp: string
) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  if (groupRelayMode) return

  const pc = store.peerConnections[fromUserId]
  if (!pc) return

  try {
    await pc.setRemoteDescription({ type: 'answer', sdp })
    await flushIceQueue(fromUserId, pc)
    syncRemoteFromReceivers(fromUserId, pc)
  } catch (err) {
    console.error(`[GC.SIGNAL] Failed to handle answer from ${fromUserId.slice(0, 8)}:`, err)
  }
}

/** Handle incoming ICE candidate from another participant. */
export async function handleGroupCallIce(
  roomId: string,
  fromUserId: string,
  candidate: unknown
) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  if (groupRelayMode) return

  const pc = store.peerConnections[fromUserId]
  const iceCandidate = candidate as RTCIceCandidateInit | null

  // End-of-candidates marker: peers relay `candidate: null` when gathering
  // finishes. Constructing RTCIceCandidate from it throws (sdpMid and
  // sdpMLineIndex both null) — signal end-of-candidates instead.
  if (!iceCandidate || !iceCandidate.candidate) {
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate() } catch { /* older impls may not support */ }
    }
    return
  }

  if (pc?.remoteDescription) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(iceCandidate))
    } catch (e) {
      console.error(`[GC.ICE] Add candidate failed for ${fromUserId.slice(0, 8)}:`, e)
    }
  } else {
    // Queue until remote description is set
    const queue = pendingIce.get(fromUserId) ?? []
    queue.push(iceCandidate)
    pendingIce.set(fromUserId, queue)
  }
}

/** Handle mute state change from a participant. */
export function handleMuteChange(roomId: string, userId: string, isMuted: boolean) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  store.updateParticipant(userId, { isMuted })
}

/** Handle video toggle from a participant. */
export function handleVideoToggle(roomId: string, userId: string, isVideoOff: boolean) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  store.updateParticipant(userId, { isVideoOff })
}

/** Handle speaking state change from a participant. */
export function handleSpeakingChange(roomId: string, userId: string, isSpeaking: boolean) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  store.updateParticipant(userId, { isSpeaking })
}

/** Toggle local microphone mute. */
export function toggleGroupCallMute() {
  if (livekitActive) {
    void loadLiveKitManager().then((lk) => lk.toggleLiveKitMute())
    return
  }
  const store = useGroupCallStore.getState()
  if (!store.localStream || !store.roomId) return

  const audioTracks = store.localStream.getAudioTracks()
  audioTracks.forEach((t) => (t.enabled = !t.enabled))
  const isMuted = !(audioTracks[0]?.enabled ?? true)

  sendGroupCallSignal({
    type: 'group_call:mute',
    room_id: store.roomId,
    is_muted: isMuted,
  })
}

/**
 * Toggle the local camera on/off. A group call starts audio-only, so the first
 * opt-in lazily acquires the camera via getUserMedia (mirroring the 1:1
 * `toggleCamera`); afterwards it just flips the existing camera track's
 * `enabled` flag.
 *
 * The camera track is kept distinct from the screen track at all times. While
 * screen-sharing the camera is detached: its state still flips so it is
 * restored correctly when sharing stops, but it is neither published nor
 * broadcast (the screen owns the video sender — remote peers keep seeing the
 * screen, not "camera off").
 */
export async function toggleGroupCallVideo(): Promise<void> {
  if (livekitActive) {
    const lk = await loadLiveKitManager()
    await lk.toggleLiveKitVideo()
    return
  }
  if (groupRelayMode) return
  const store = useGroupCallStore.getState()
  const local = store.localStream
  if (!local || !store.roomId) return

  // Lazy acquisition: no camera track yet -> turn the camera ON.
  if (!groupCameraTrack || groupCameraTrack.readyState === 'ended') {
    let camStream: MediaStream
    try {
      const prefs = loadMediaPrefs()
      camStream = await navigator.mediaDevices.getUserMedia({
        video: getUserMediaConstraints({ video: true, hd: !prefs.lowBandwidth }).video,
        audio: false,
      })
    } catch (err) {
      console.error('[GC.MEDIA] Camera acquisition failed:', err)
      return
    }
    const rawCamera = camStream.getVideoTracks()[0] ?? null
    if (!rawCamera) return
    // Background effects wrap the raw track before publishing.
    const camera = await wrapGroupCameraTrack(rawCamera)
    groupCameraTrack = camera
    camera.enabled = true
    // The camera is fully independent of the screen share (dual mode) —
    // publish on the CAMERA slot, excluding the screen's own sender.
    if (!local.getVideoTracks().includes(camera)) local.addTrack(camera)
    for (const pc of Object.values(store.peerConnections)) {
      applyVideoTrack(pc, camera, local, groupScreenTrack)
    }
    store.setLocalStream(local)
    store.bumpLocalMediaRev()
    sendGroupCallSignal({
      type: 'group_call:video_toggle',
      room_id: store.roomId,
      is_video_off: false,
    })
    return
  }

  // Existing camera track -> HARD off: stop the hardware (LED out), clear the
  // sender track, drop the ref. `enabled = false` alone kept the device open.
  const cam = groupCameraTrack
  for (const pc of Object.values(store.peerConnections)) {
    applyVideoTrack(pc, null, local, groupScreenTrack)
  }
  if (local.getVideoTracks().includes(cam)) local.removeTrack(cam)
  // Tears down the effects chain too — it owns the RAW hardware track.
  stopGroupCameraTrack(cam)
  groupCameraTrack = null
  store.setLocalStream(local)
  store.bumpLocalMediaRev()

  sendGroupCallSignal({
    type: 'group_call:video_toggle',
    room_id: store.roomId,
    is_video_off: true,
  })
}

/**
 * Start screen sharing in the group call. Acquires the screen via
 * getDisplayMedia ONLY — it never calls getUserMedia and never enables the
 * camera track. The screen video track replaces the video sender on every peer;
 * the camera track (if any) is merely detached from the local stream, keeping
 * its on/off state, and is restored when sharing stops.
 */
export async function startGroupCallScreenShare(): Promise<boolean> {
  if (livekitActive) {
    const lk = await loadLiveKitManager()
    await lk.toggleLiveKitScreenShare()
    return true
  }
  if (groupRelayMode) return false
  const store = useGroupCallStore.getState()
  if (!store.localStream || !store.roomId) return false
  // Already sharing — ignore (toggle-off goes through stopGroupCallScreenShare).
  if (groupScreenTrack) return true

  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia(
      getDisplayMediaOptions()
    )

    const screenVideoTrack = screenStream.getVideoTracks()[0]
    if (!screenVideoTrack) {
      screenStream.getTracks().forEach((t) => t.stop())
      return false
    }
    applyScreenTrackSettings(screenVideoTrack)
    const screenAudioTrack = screenStream.getAudioTracks()[0] ?? null

    // Dual camera+screen: the screen rides its OWN senders under a DEDICATED
    // msid announced ahead of the tracks, so peers split it into a separate
    // tile while the camera keeps flowing untouched (mirrors the 1:1 path).
    const msidStream = new MediaStream()
    groupScreenTrack = screenVideoTrack
    groupScreenAudioTrack = screenAudioTrack

    sendGroupCallSignal({
      type: 'group_call:screen_share',
      room_id: store.roomId,
      active: true,
      stream_id: msidStream.id,
    })

    for (const [peerId, pc] of Object.entries(store.peerConnections)) {
      const videoSender = pc.addTrack(screenVideoTrack, msidStream)
      const entry: { video: RTCRtpSender; audio?: RTCRtpSender } = { video: videoSender }
      if (screenAudioTrack) {
        entry.audio = pc.addTrack(screenAudioTrack, msidStream)
      }
      groupScreenSenders.set(peerId, entry)
    }

    store.setLocalScreenStream(new MediaStream([screenVideoTrack]))
    store.bumpLocalMediaRev()

    // Encoder budget for the chosen preset (4K/120fps need far more than the
    // ~2.5 Mbps WebRTC default).
    {
      const prefs = loadMediaPrefs()
      const maxBitrate = getScreenShareMaxBitrateBps(prefs.screenRes, prefs.screenFps)
      const degradation = getScreenShareDegradationPreference(prefs.screenContent)
      for (const pc of Object.values(store.peerConnections)) {
        void tuneScreenShareSender(pc, screenVideoTrack, maxBitrate, degradation)
      }
    }

    // "Stop sharing" from the browser-native control.
    screenVideoTrack.onended = () => {
      void stopGroupCallScreenShare()
    }

    return true
  } catch (err) {
    if ((err as Error)?.name !== 'NotAllowedError') {
      console.error('[GC.MEDIA] Screen share failed:', err)
    }
    return false
  }
}

export async function handleGroupCallRelayFrame(
  roomId: string,
  fromUserId: string,
  ciphertext: string,
  iv: string,
  sampleRate: number,
  seq: number | null
): Promise<void> {
  const store = useGroupCallStore.getState()
  if (!groupRelayMode || store.roomId !== roomId) return
  // Strictly increasing, exactly like the 1:1 path. Without it a captured frame
  // replays verbatim — the key is stable for the whole call — and reordered
  // frames play as if fresh: audio an attacker can rewind and repeat.
  if (seq === null) return
  const lastSeq = relaySeqIn.get(fromUserId) ?? 0
  if (seq <= lastSeq) return
  const myUserId = useSessionStore.getState().userId
  if (!myUserId) return
  const sharedKey = await resolveRelaySharedKey(fromUserId, roomId)
  if (!sharedKey) return
  try {
    // The AAD must reproduce the sender's exactly. A frame lifted from the
    // other direction, another room, or another position fails the tag instead
    // of decrypting.
    const pcm = await decryptBytes(
      sharedKey,
      ciphertext,
      iv,
      groupRelayFrameAad(roomId, fromUserId, myUserId, seq)
    )
    relaySeqIn.set(fromUserId, seq)
    const player = ensureRelayPlayer(fromUserId)
    await player.pushFrame(pcm, sampleRate)
    store.updateParticipant(fromUserId, { connectionState: 'connected' })
  } catch (err) {
    console.warn('[GC.RELAY] Failed to decrypt relay frame for', fromUserId.slice(0, 8), err)
  }
}

/**
 * Stop screen sharing. The screen lives on its OWN senders (dual
 * camera+screen), so stopping is removing those senders and the capture —
 * the camera is never touched.
 */
export function stopGroupCallScreenShare(): void {
  if (groupRelayMode) return
  const screen = groupScreenTrack
  if (!screen) return
  const store = useGroupCallStore.getState()

  screen.onended = null

  for (const [peerId, pc] of Object.entries(store.peerConnections)) {
    const senders = groupScreenSenders.get(peerId)
    if (!senders) continue
    try { pc.removeTrack(senders.video) } catch { /* closed */ }
    if (senders.audio) {
      try { pc.removeTrack(senders.audio) } catch { /* closed */ }
    }
  }
  groupScreenSenders.clear()

  screen.stop()
  groupScreenAudioTrack?.stop()
  groupScreenAudioTrack = null
  groupScreenTrack = null
  store.setLocalScreenStream(null)
  store.bumpLocalMediaRev()

  if (store.roomId) {
    sendGroupCallSignal({
      type: 'group_call:screen_share',
      room_id: store.roomId,
      active: false,
    })
  }
}

/** Incoming screen_share signal: register/unregister the peer's screen msid. */
export function handleGroupScreenShare(
  roomId: string,
  fromUserId: string,
  active: boolean,
  streamId: string | null
): void {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
  if (active && streamId) {
    groupRemoteScreenStreamIds.set(fromUserId, streamId)
  } else if (!active) {
    groupRemoteScreenStreamIds.delete(fromUserId)
    store.removeRemoteStream(`${fromUserId}#screen`)
  }
}

/** Get participant count for the current call. */
export function getGroupCallParticipantCount(): number {
  const store = useGroupCallStore.getState()
  return Object.keys(store.participants).length + 1 // +1 for self
}

/** Whether the current group screen-share captured an audio track. */
export function hasGroupScreenAudio(): boolean {
  return groupScreenAudioTrack !== null
}

/** Whether the group screen-share audio is currently muted locally. */
export function isGroupScreenAudioMuted(): boolean {
  return groupScreenAudioTrack !== null && !groupScreenAudioTrack.enabled
}

/**
 * Mute/unmute the group screen-share AUDIO (video untouched). Returns the new
 * muted state. Peers receive silence while muted; no renegotiation.
 */
export function toggleGroupScreenAudioMuted(): boolean {
  const track = groupScreenAudioTrack
  if (!track) return false
  track.enabled = !track.enabled
  return !track.enabled
}

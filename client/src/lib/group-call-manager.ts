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
import { applyVideoTrack, planScreenShareStart, planScreenShareStop } from '@/lib/call-media-tracks'
import { getUserMediaConstraints, loadMediaPrefs } from '@/lib/media-devices'



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
        const roomId = useGroupCallStore.getState().roomId
        if (!roomId) return
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
    if (ev.streams[0]) {
      useGroupCallStore.getState().setRemoteStream(peerId, ev.streams[0])
      setupSpeakingDetection(peerId, ev.streams[0])
    }
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

  // Clean remote stream
  const remote = store.remoteStreams[peerId]
  if (remote) terminateFeed(remote)
  store.removeRemoteStream(peerId)

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

  // Stop the screen track(s) (if sharing) and local stream.
  groupScreenTrack?.stop()
  groupScreenAudioTrack?.stop()
  terminateFeed(store.localStream)
  groupCameraTrack = null
  groupScreenTrack = null
  groupScreenAudioTrack = null

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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
  } catch (err) {
    console.error('[GC.RELAY] Failed to get audio media:', err)
    return false
  }

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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        : false,
    })
  } catch (err) {
    console.error('[GC.MEDIA] Failed to get media:', err)
    return false
  }

  store.setLocalStream(stream)
  store.setIsInGroupCall(true)
  store.setRoomId(roomId)
  store.setIsVideo(isVideo)
  store.setTransport('mesh')
  // Remember the camera track so screen-share can detach (never stop) it and
  // restore it afterwards — distinct from the screen track.
  groupCameraTrack = stream.getVideoTracks()[0] ?? null

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
    await pc.setLocalDescription(answer)
    sendGroupCallSignal({
      type: 'group_call:answer',
      room_id: roomId,
      target_user_id: fromUserId,
      sdp: answer.sdp ?? '',
    })
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
  if (!groupCameraTrack) {
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
    const camera = camStream.getVideoTracks()[0] ?? null
    if (!camera) return
    groupCameraTrack = camera
    camera.enabled = true
    // While screen-sharing keep the camera detached; otherwise publish it.
    if (!groupScreenTrack) {
      if (!local.getVideoTracks().includes(camera)) local.addTrack(camera)
      for (const pc of Object.values(store.peerConnections)) {
        applyVideoTrack(pc, camera, local)
      }
    }
    store.setLocalStream(local)
    if (!groupScreenTrack) {
      sendGroupCallSignal({
        type: 'group_call:video_toggle',
        room_id: store.roomId,
        is_video_off: false,
      })
    }
    return
  }

  // Existing camera track -> flip enabled state.
  groupCameraTrack.enabled = !groupCameraTrack.enabled

  // Don't leak camera on/off signalling to peers while the screen is shared.
  if (groupScreenTrack) return

  sendGroupCallSignal({
    type: 'group_call:video_toggle',
    room_id: store.roomId,
    is_video_off: !groupCameraTrack.enabled,
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
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    })

    const screenVideoTrack = screenStream.getVideoTracks()[0]
    if (!screenVideoTrack) {
      screenStream.getTracks().forEach((t) => t.stop())
      return false
    }

    const local = store.localStream
    // Detach the camera track from the local stream WITHOUT stopping it — the
    // camera keeps its enabled/disabled state and is restored when sharing
    // ends. The camera is never enabled or (re)acquired here.
    const plan = planScreenShareStart(groupCameraTrack, screenVideoTrack)
    if (plan.detachFromLocal && local.getVideoTracks().includes(plan.detachFromLocal)) {
      local.removeTrack(plan.detachFromLocal)
    }

    // Publish the screen track in place of the camera on every peer.
    for (const pc of Object.values(store.peerConnections)) {
      applyVideoTrack(pc, plan.publish, local)
    }
    local.addTrack(plan.attachToLocal)
    groupScreenTrack = screenVideoTrack
    store.setLocalStream(local)

    // Remote peers now receive video (the screen) — keep their video-off
    // indicator accurate. Uses the existing video_toggle channel.
    sendGroupCallSignal({
      type: 'group_call:video_toggle',
      room_id: store.roomId,
      is_video_off: false,
    })

    // "Stop sharing" from the browser-native control.
    screenVideoTrack.onended = () => {
      void stopGroupCallScreenShare()
    }

    // Add screen audio (if the user shared a tab with audio) to every peer.
    const screenAudioTrack = screenStream.getAudioTracks()[0]
    if (screenAudioTrack) {
      groupScreenAudioTrack = screenAudioTrack
      for (const pc of Object.values(store.peerConnections)) {
        pc.addTrack(screenAudioTrack, screenStream)
      }
      const origOnEnded = screenVideoTrack.onended
      screenVideoTrack.onended = () => {
        screenAudioTrack.stop()
        if (typeof origOnEnded === 'function') {
          origOnEnded.call(screenVideoTrack, new Event('ended'))
        }
      }
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
 * Stop screen sharing and restore the pre-share video state. Restores the
 * camera track ONLY if a camera track existed before/while sharing — keeping
 * its prior enabled/disabled state untouched; an audio-only call returns to
 * audio-only. Never calls getUserMedia and never enables the camera.
 */
export function stopGroupCallScreenShare(): void {
  if (groupRelayMode) return
  const screen = groupScreenTrack
  if (!screen) return
  const store = useGroupCallStore.getState()
  const local = store.localStream

  screen.onended = null

  if (local) {
    const plan = planScreenShareStop(groupCameraTrack, screen)
    // Drop the screen track from the local stream.
    if (plan.detachFromLocal && local.getVideoTracks().includes(plan.detachFromLocal)) {
      local.removeTrack(plan.detachFromLocal)
    }
    // Re-attach the camera track if it exists, otherwise leave video cleared.
    if (plan.attachToLocal && !local.getVideoTracks().includes(plan.attachToLocal)) {
      local.addTrack(plan.attachToLocal)
    }
    for (const pc of Object.values(store.peerConnections)) {
      applyVideoTrack(pc, plan.publish, local)
    }
    store.setLocalStream(local)
  }

  screen.stop()
  // Stop and unpublish the screen AUDIO track too (only the native onended
  // stopped it before; the in-app stop nulls onended). Match by track identity
  // so the microphone sender survives.
  const screenAudio = groupScreenAudioTrack
  if (screenAudio) {
    for (const pc of Object.values(store.peerConnections)) {
      const sender = pc.getSenders().find((s) => s.track === screenAudio)
      if (sender) pc.removeTrack(sender)
    }
    screenAudio.stop()
    groupScreenAudioTrack = null
  }
  groupScreenTrack = null

  // Sync remote video-off indicators with the restored camera state: video is
  // off unless a camera track exists and is enabled.
  if (store.roomId) {
    sendGroupCallSignal({
      type: 'group_call:video_toggle',
      room_id: store.roomId,
      is_video_off: !(groupCameraTrack !== null && groupCameraTrack.enabled),
    })
  }
}

/** Get participant count for the current call. */
export function getGroupCallParticipantCount(): number {
  const store = useGroupCallStore.getState()
  return Object.keys(store.participants).length + 1 // +1 for self
}

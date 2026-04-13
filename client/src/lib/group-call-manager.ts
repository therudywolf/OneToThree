'use client'

/**
 * PROJECT 13 :: GROUP_CALL_MESH_MANAGER
 * Level: Transmission Layer (Full Mesh WebRTC)
 * Vibe: Clinical Steel / Terminal Noir
 *
 * Manages N-1 peer connections for group calls (up to 8 participants).
 * Each participant creates a direct WebRTC connection to every other participant.
 */

import { getFmSocket } from '@/lib/api/socket'
import { useGroupCallStore } from '@/store/groupCallStore'
import type { GroupCallParticipant as _GroupCallParticipant } from '@/store/groupCallStore'

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/turn', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`RELAY_FETCH_FAIL: ${res.status}`)
    const payload = (await res.json()) as { iceServers?: RTCIceServer[] }
    if (!payload.iceServers) throw new Error('MALFORMED_RELAY_PAYLOAD')

    return payload.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls)
        ? server.urls.flatMap((u) =>
            u.startsWith('turn:')
              ? [`${u}?transport=tcp`, `${u}?transport=udp`]
              : [u]
          )
        : typeof server.urls === 'string' && server.urls.startsWith('turn:')
          ? [`${server.urls}?transport=tcp`, `${server.urls}?transport=udp`]
          : server.urls,
    }))
  } catch (err) {
    console.warn('[GC.ICE] Relay nodes unreachable, using default STUN.', err)
    return DEFAULT_STUN
  }
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

/** Audio analysers for speaking detection. */
const audioAnalysers = new Map<string, { analyser: AnalyserNode; context: AudioContext; interval: number }>()

/** Cached ICE servers for this session. */
let cachedIceServers: RTCIceServer[] | null = null

async function ensureIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers
  cachedIceServers = await getIceServers()
  return cachedIceServers
}

function sendGroupCallSignal(payload: object) {
  getFmSocket().send(payload)
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
    } else if (state === 'failed') {
      console.warn(`[GC.ICE] Connection failed to ${peerId.slice(0, 8)}, attempting restart`)
      try {
        pc.restartIce()
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
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendGroupCallSignal({
        type: 'group_call:offer',
        room_id: roomId,
        target_user_id: peerId,
        sdp: offer.sdp ?? '',
        is_video: store.isVideo,
      })
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

  // Stop local stream
  terminateFeed(store.localStream)

  // Clear cached ICE servers
  cachedIceServers = null

  // Reset store
  store.reset()
}

// --- Public API ---

/** Join a group call room. Initiates connections to all existing participants. */
export async function joinGroupCall(
  roomId: string,
  isVideo: boolean
): Promise<boolean> {
  const store = useGroupCallStore.getState()

  // Don't join if already in a call
  if (store.isInGroupCall) return false

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

  // Signal server to join the room
  sendGroupCallSignal({
    type: 'group_call:join',
    room_id: roomId,
    is_video: isVideo,
  })

  return true
}

/** Leave the current group call. */
export function leaveGroupCall() {
  cleanupAll()
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

  const iceServers = await ensureIceServers()

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

    // Create peer connection and send offer
    if (store.localStream) {
      createPeerConnection(roomId, p.userId, store.localStream, iceServers)
    }
  }
}

/** Handle a new member joining the call room. */
export function handleMemberJoin(roomId: string, userId: string, username: string) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return

  store.setParticipant(userId, {
    userId,
    username,
    isMuted: false,
    isVideoOff: false,
    isSpeaking: false,
    connectionState: 'pending',
  })

  // The new member will send us an offer; we wait for it.
}

/** Handle a member leaving the call room. */
export function handleMemberLeave(roomId: string, userId: string) {
  const store = useGroupCallStore.getState()
  if (store.roomId !== roomId) return
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

  let pc = store.peerConnections[fromUserId]

  if (!pc) {
    const iceServers = await ensureIceServers()
    pc = createPeerConnection(roomId, fromUserId, store.localStream, iceServers)
  }

  try {
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

  const pc = store.peerConnections[fromUserId]
  const iceCandidate = candidate as RTCIceCandidateInit

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

/** Toggle local camera on/off. */
export function toggleGroupCallVideo() {
  const store = useGroupCallStore.getState()
  if (!store.localStream || !store.roomId) return

  const videoTracks = store.localStream.getVideoTracks()
  videoTracks.forEach((t) => (t.enabled = !t.enabled))
  const isVideoOff = !(videoTracks[0]?.enabled ?? false)

  sendGroupCallSignal({
    type: 'group_call:video_toggle',
    room_id: store.roomId,
    is_video_off: isVideoOff,
  })
}

/** Start screen sharing in the group call. */
export async function startGroupCallScreenShare(): Promise<boolean> {
  const store = useGroupCallStore.getState()
  if (!store.localStream || !store.roomId) return false

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

    // Replace video track in all peer connections
    for (const pc of Object.values(store.peerConnections)) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) void sender.replaceTrack(screenVideoTrack)
    }

    // Replace in local stream
    const oldTrack = store.localStream.getVideoTracks()[0]
    if (oldTrack) {
      store.localStream.removeTrack(oldTrack)
    }
    store.localStream.addTrack(screenVideoTrack)
    store.setLocalStream(store.localStream)

    // Handle screen share stop
    screenVideoTrack.onended = () => {
      void stopGroupCallScreenShare(oldTrack ?? null)
    }

    return true
  } catch (err) {
    if ((err as Error)?.name !== 'NotAllowedError') {
      console.error('[GC.MEDIA] Screen share failed:', err)
    }
    return false
  }
}

/** Stop screen sharing and restore camera. */
async function stopGroupCallScreenShare(originalTrack: MediaStreamTrack | null) {
  const store = useGroupCallStore.getState()
  if (!store.localStream) return

  const currentTrack = store.localStream.getVideoTracks()[0]
  if (currentTrack) {
    currentTrack.onended = null
    currentTrack.stop()
    store.localStream.removeTrack(currentTrack)
  }

  if (originalTrack) {
    store.localStream.addTrack(originalTrack)
    for (const pc of Object.values(store.peerConnections)) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) void sender.replaceTrack(originalTrack)
    }
  }

  store.setLocalStream(store.localStream)
}

/** Get participant count for the current call. */
export function getGroupCallParticipantCount(): number {
  const store = useGroupCallStore.getState()
  return Object.keys(store.participants).length + 1 // +1 for self
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { startOutgoingRingtone } from '@/lib/call-ringtones'
import { isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS } from '@/lib/ios'
import { getUserMediaConstraints } from '@/lib/media-devices'
import {
  isMediaPermissionDenied,
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
} from '@/lib/media-limits'
import { useCallStore } from '@/store/callStore'
import { useChatStore } from '@/store/chatStore'

const DEFAULT_STUN: RTCIceServer = { urls: 'stun:stun.l.google.com:19302' }

/** ICE servers from env only. When the API host is behind Cloudflare proxy, TURN must use a
 * separate DNS-only hostname (UDP) — do not point NEXT_PUBLIC_TURN_URL at the same host as NEXT_PUBLIC_API_URL.
 */
function buildIceServers(): RTCIceServer[] {
  const turnUrl =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_TURN_URL?.trim()
      : undefined
  const turnUser =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_TURN_USERNAME?.trim()
      : undefined
  const turnPass =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_TURN_PASSWORD?.trim()
      : undefined

  if (turnUrl && turnUser && turnPass) {
    const urls = turnUrl
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (urls.length === 0) {
      console.warn('[ICE] TURN_URL configured but empty, using defaults')
      return [DEFAULT_STUN]
    }
    console.warn('[ICE] Configured TURN servers:', { count: urls.length, user: turnUser })
    return [
      DEFAULT_STUN,
      {
        urls,
        username: turnUser,
        credential: turnPass,
      },
    ]
  }
  console.warn('[ICE] No TURN configured, using STUN only')
  return [DEFAULT_STUN]
}

function stopStreamTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

type SignalPayload =
  | { kind: 'offer'; sdp: string; isVideo?: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null }
  | { kind: 'media_state'; media: 'audio' | 'video'; enabled: boolean }

function sendSignal(targetUserId: string, signalData: SignalPayload) {
  const label = `[SIGNAL→${targetUserId.slice(0, 8)}]`
  const kind = signalData.kind
  console.warn(
    `${label} Sending ${kind}`,
    kind === 'offer' || kind === 'answer'
      ? { kind, sdpLen: (signalData as { sdp?: string }).sdp?.length ?? 0 }
      : kind === 'ice'
        ? { kind, candidate: (signalData as { candidate?: unknown }).candidate }
        : { kind, media: (signalData as { media?: string }).media }
  )
  getFmSocket().send({ type: 'webrtc_signal', targetUserId, signalData })
}

function isSignalPayload(x: unknown): x is SignalPayload {
  if (!x || typeof x !== 'object') return false
  const o = x as { kind?: string }
  if (o.kind === 'offer')
    return typeof (x as { sdp?: string }).sdp === 'string'
  if (o.kind === 'answer')
    return typeof (x as { sdp?: string }).sdp === 'string'
  if (o.kind === 'ice') return 'candidate' in (x as object)
  return false
}

export function useWebRTC(userId: string | null) {
  const [peerReady, setPeerReady] = useState(false)
  const [mediaAccessError, setMediaAccessError] = useState<string | null>(null)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const pcsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({})
  /** Camera track swapped out while getDisplayMedia is active (same object restored on revert). */
  const originalVideoTrackRef = useRef<MediaStreamTrack | null>(null)
  /** Active screen-capture track (stop on revert; onended → revert). */
  const screenVideoTrackRef = useRef<MediaStreamTrack | null>(null)
  const revertToCameraRef = useRef<() => void>(() => {})
  /** Browser `setTimeout` id (avoid NodeJS `Timeout` typing in client). */
  const iceDisconnectTimersRef = useRef(new Map<string, number>())
  const outgoingRingStopRef = useRef<(() => void) | null>(null)
  const facingModeRef = useRef<'user' | 'environment'>('user')

  const setIncomingCall = useCallStore((s) => s.setIncomingCall)
  const resetCallStore = useCallStore((s) => s.reset)
  const addPeerConnection = useCallStore((s) => s.addPeerConnection)
  const removePeerConnection = useCallStore((s) => s.removePeerConnection)
  const setRemoteStream = useCallStore((s) => s.setRemoteStream)
  const removeRemoteStream = useCallStore((s) => s.removeRemoteStream)
  const setLocalStream = useCallStore((s) => s.setLocalStream)
  const setIsCalling = useCallStore((s) => s.setIsCalling)
  const clearRemotePeerMedia = useCallStore((s) => s.clearRemotePeerMedia)

  const flushPendingIce = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    // Snapshot the queue to handle candidates arriving during flush
    const q = pendingIceRef.current[peerId]
    if (!q?.length) {
      console.warn(`[FLUSH←${peerId.slice(0, 8)}] No pending ICE candidates`)
      return
    }
    
    // Capture current length - new candidates may arrive during flush
    const candidatesToFlush = [...q]
    console.warn(
      `[FLUSH←${peerId.slice(0, 8)}] Flushing ${candidatesToFlush.length} pending ICE candidates...`
    )
    
    // Process snapshot
    for (const c of candidatesToFlush) {
      try {
        // Skip null candidates (end-of-candidates marker)
        if (!c) {
          console.warn(`[FLUSH←${peerId.slice(0, 8)}] Skipping null candidate (end-of-candidates)`)
          continue
        }
        await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (err) {
        const errMsg = (err as Error)?.message ?? 'Unknown error'
        console.warn(
          `[FLUSH←${peerId.slice(0, 8)}] Failed to add pending candidate:`,
          errMsg
        )
      }
    }
    
    // Clear only the candidates we just processed; new ones may have arrived
    pendingIceRef.current[peerId] = q.slice(candidatesToFlush.length)
    if (pendingIceRef.current[peerId].length === 0) {
      delete pendingIceRef.current[peerId]
    }
    console.warn(`[FLUSH←${peerId.slice(0, 8)}] Flush complete`)
  }, [])

  const clearIceDisconnectTimer = useCallback((peerId: string) => {
    const t = iceDisconnectTimersRef.current.get(peerId)
    if (t) {
      clearTimeout(t)
      iceDisconnectTimersRef.current.delete(peerId)
    }
  }, [])

  const cleanupPeer = useCallback(
    (peerId: string) => {
      clearIceDisconnectTimer(peerId)
      const remote = useCallStore.getState().remoteStreams[peerId]
      if (remote) {
        stopStreamTracks(remote)
      }
      const pc = pcsRef.current.get(peerId)
      if (pc) {
        pc.close()
        pcsRef.current.delete(peerId)
      }
      removePeerConnection(peerId)
      removeRemoteStream(peerId)
      clearRemotePeerMedia(peerId)
      delete pendingIceRef.current[peerId]
    },
    [removePeerConnection, removeRemoteStream, clearRemotePeerMedia, clearIceDisconnectTimer]
  )

  const revertToCamera = useCallback(() => {
    const orig = originalVideoTrackRef.current
    const screen = screenVideoTrackRef.current
    const local = useCallStore.getState().localStream

    if (screen) {
      screen.onended = null
    }

    if (orig && local) {
      for (const [, pc] of pcsRef.current) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) {
          void sender.replaceTrack(orig)
        }
      }
      const currentVid = local.getVideoTracks()[0]
      if (currentVid && currentVid !== orig) {
        local.removeTrack(currentVid)
        currentVid.stop()
      }
      if (!local.getVideoTracks().includes(orig)) {
        local.addTrack(orig)
      }
      setLocalStream(local)
    } else if (screen && local) {
      const currentVid = local.getVideoTracks()[0]
      if (currentVid) {
        local.removeTrack(currentVid)
        currentVid.stop()
      }
      setLocalStream(local)
    }

    screen?.stop()
    originalVideoTrackRef.current = null
    screenVideoTrackRef.current = null
    setIsScreenSharing(false)
  }, [setLocalStream])

  const maybeResetCallIfNoPeers = useCallback(() => {
    if (pcsRef.current.size > 0) return
    outgoingRingStopRef.current?.()
    outgoingRingStopRef.current = null
    const state = useCallStore.getState()
    if (
      !state.isCalling &&
      state.incomingCall == null &&
      state.localStream == null
    ) {
      return
    }
    revertToCamera()
    for (const stream of Object.values(state.remoteStreams)) {
      stopStreamTracks(stream)
    }
    stopStreamTracks(state.localStream)
    resetCallStore()
  }, [resetCallStore, revertToCamera])

  useEffect(() => {
    revertToCameraRef.current = revertToCamera
  }, [revertToCamera])

  /** iOS suspends getDisplayMedia when backgrounded; tear down screen share to avoid stuck/black video. */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'hidden') return
      if (screenVideoTrackRef.current) {
        revertToCameraRef.current()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const endCall = useCallback(() => {
    outgoingRingStopRef.current?.()
    outgoingRingStopRef.current = null
    setMediaAccessError(null)
    revertToCamera()
    const chatId = useChatStore.getState().activeChatId
    if (chatId) {
      getFmSocket().send({ type: 'call_leave', chat_id: chatId })
    }
    for (const id of Array.from(pcsRef.current.keys())) {
      cleanupPeer(id)
    }
    const after = useCallStore.getState()
    for (const stream of Object.values(after.remoteStreams)) {
      stopStreamTracks(stream)
    }
    stopStreamTracks(after.localStream)
    resetCallStore()
  }, [cleanupPeer, resetCallStore, revertToCamera])

  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    return socket.subscribe((msg) => {
      if (msg.type === 'call_invite') {
        console.warn(
          `[INVITE] call_invite from ${msg.from_user_id.slice(0, 8)} (video=${msg.is_video})`
        )
        const state = useCallStore.getState()
        if (state.isCalling) {
          console.warn('[INVITE] Already calling, ignoring invite')
          return
        }
        if (state.incomingCall) {
          console.warn('[INVITE] Already have incoming call, ignoring')
          return
        }
        console.warn('[INVITE] Setting incomingCall state')
        setIncomingCall({
          peerId: msg.from_user_id,
          isVideo: msg.is_video,
          offer: { type: 'offer', sdp: '' },
        })
      }
      if (msg.type === 'call_leave') {
        console.warn(
          `[INVITE] call_leave from ${msg.from_user_id.slice(0, 8)}`
        )
        cleanupPeer(msg.from_user_id)
        maybeResetCallIfNoPeers()
      }
    })
  }, [userId, setIncomingCall, cleanupPeer, maybeResetCallIfNoPeers])

  useEffect(() => {
    if (!userId) {
      setPeerReady(false)
      endCall()
      return
    }
    const socket = getFmSocket()
    const id = window.setInterval(() => setPeerReady(socket.connected), 1000)
    setPeerReady(socket.connected)
    return () => {
      window.clearInterval(id)
      endCall()
    }
  }, [userId, endCall])

  const attachPeerHandlers = useCallback(
    (peerId: string, pc: RTCPeerConnection) => {
      const teardownIfStillThisPc = () => {
        if (pcsRef.current.get(peerId) !== pc) return
        if (!pcsRef.current.has(peerId)) return
        cleanupPeer(peerId)
        maybeResetCallIfNoPeers()
      }

      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState
        console.warn(
          `[PC←${peerId.slice(0, 8)}] iceConnectionState: ${st} (connectionState: ${pc.connectionState})`
        )
        if (st === 'connected' || st === 'completed') {
          console.warn(`[PC←${peerId.slice(0, 8)}] ✓ Connected!`)
          clearIceDisconnectTimer(peerId)
          outgoingRingStopRef.current?.()
          outgoingRingStopRef.current = null
          return
        }
        if (st === 'failed' || st === 'closed') {
          console.error(
            `[PC←${peerId.slice(0, 8)}] ✗ ${st}, cleaning up`
          )
          clearIceDisconnectTimer(peerId)
          teardownIfStillThisPc()
          return
        }
        if (st === 'disconnected') {
          console.warn(
            `[PC←${peerId.slice(0, 8)}] Disconnected, waiting 3.2s before teardown`
          )
          clearIceDisconnectTimer(peerId)
          const timerId = window.setTimeout(() => {
            iceDisconnectTimersRef.current.delete(peerId)
            if (pcsRef.current.get(peerId) !== pc) return
            if (pc.iceConnectionState !== 'disconnected') return
            console.error(`[PC←${peerId.slice(0, 8)}] ICE still disconnected, tearing down`)
            teardownIfStillThisPc()
          }, 3200)
          iceDisconnectTimersRef.current.set(peerId, timerId)
        }
      }

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState
        console.warn(
          `[PC←${peerId.slice(0, 8)}] connectionState: ${st} (iceConnectionState: ${pc.iceConnectionState})`
        )
        if (st === 'failed' || st === 'closed') {
          console.error(`[PC←${peerId.slice(0, 8)}] Connection ${st}, cleaning up`)
          clearIceDisconnectTimer(peerId)
          teardownIfStillThisPc()
        }
      }
      pc.ontrack = (ev) => {
        console.warn(
          `[PC←${peerId.slice(0, 8)}] ontrack event: ${ev.track.kind}`,
          { streamCount: ev.streams.length }
        )
        if (ev.streams[0]) {
          console.warn(`[PC←${peerId.slice(0, 8)}] Setting remote stream`)
          setRemoteStream(peerId, ev.streams[0])
        }
      }
      pc.onicecandidate = (ev) => {
        // WARNING: ICE candidate routing must stay peer-targeted.
        // Broadcasting candidates to non-target peers can leak network metadata
        // and break connection establishment in full-mesh calls.
        if (ev.candidate) {
          console.warn(
            `[PC←${peerId.slice(0, 8)}] onicecandidate: ${ev.candidate.candidate.slice(0, 50)}...`
          )
        } else {
          console.warn(`[PC←${peerId.slice(0, 8)}] onicecandidate: (end of candidates)`)
        }
        sendSignal(peerId, {
          kind: 'ice',
          candidate: ev.candidate ? ev.candidate.toJSON() : null,
        })
      }
    },
    [
      setRemoteStream,
      cleanupPeer,
      maybeResetCallIfNoPeers,
      clearIceDisconnectTimer,
    ]
  )

  useEffect(() => {
    if (!userId) return

    const handleSignal = async (fromUserId: string, raw: unknown) => {
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as { kind?: string }).kind === 'media_state'
      ) {
        const m = raw as {
          media?: string
          enabled?: boolean
        }
        if (
          (m.media === 'audio' || m.media === 'video') &&
          typeof m.enabled === 'boolean'
        ) {
          if (m.media === 'audio') {
            useCallStore.getState().setRemotePeerMedia(fromUserId, {
              micMuted: !m.enabled,
            })
          } else {
            useCallStore.getState().setRemotePeerMedia(fromUserId, {
              cameraOff: !m.enabled,
            })
          }
        }
        return
      }

      if (!isSignalPayload(raw)) return
      const data = raw

      if (data.kind === 'ice') {
        const pc = pcsRef.current.get(fromUserId)
        if (data.candidate && pc) {
          if (pc.remoteDescription) {
            try {
              console.warn(
                `[ICE←${fromUserId.slice(0, 8)}] Adding ice candidate: ${data.candidate.candidate?.slice(0, 50) ?? 'null'}...`
              )
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
            } catch (err) {
              const errMsg = (err as Error)?.message ?? 'Unknown error'
              console.warn(
                `[ICE←${fromUserId.slice(0, 8)}] Failed to add candidate:`,
                errMsg
              )
            }
          } else {
            console.warn(
              `[ICE←${fromUserId.slice(0, 8)}] Queueing candidate (no remoteDescription yet): ${data.candidate.candidate?.slice(0, 50) ?? 'null'}...`
            )
            const bucket = pendingIceRef.current[fromUserId] ?? []
            bucket.push(data.candidate)
            pendingIceRef.current[fromUserId] = bucket
          }
        } else {
          console.warn(`[ICE←${fromUserId.slice(0, 8)}] End of ICE candidates`)
        }
        return
      }

      if (data.kind === 'offer') {
        console.warn(
          `[SIG←${fromUserId.slice(0, 8)}] Received offer (sdp=${data.sdp?.length ?? 0} bytes)`
        )
        if (pcsRef.current.has(fromUserId)) {
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Already have PeerConnection, ignoring duplicate offer`
          )
          return
        }
        const state = useCallStore.getState()
        if (state.incomingCall?.peerId === fromUserId) {
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Incoming call already set, ignoring`
          )
          return
        }
        if (state.isCalling) {
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Already calling, ignoring incoming offer`
          )
          return
        }
        console.warn(
          `[SIG←${fromUserId.slice(0, 8)}] Setting incomingCall state (video=${!!data.isVideo})`
        )
        setIncomingCall({
          peerId: fromUserId,
          isVideo: !!data.isVideo,
          offer: { type: 'offer', sdp: data.sdp },
        })
        return
      }

      if (data.kind === 'answer') {
        console.warn(
          `[SIG←${fromUserId.slice(0, 8)}] Received answer (sdp=${data.sdp?.length ?? 0} bytes)`
        )
        const pc = pcsRef.current.get(fromUserId)
        if (!pc) {
          console.error(
            `[SIG←${fromUserId.slice(0, 8)}] No PeerConnection found for answer`
          )
          return
        }
        try {
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Setting remote description (answer)`
          )
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Remote description set, flushing pending ICE`
          )
          await flushPendingIce(fromUserId, pc)
          console.warn(
            `[SIG←${fromUserId.slice(0, 8)}] Answer handshake complete`
          )
        } catch (err) {
          console.error(
            `[SIG←${fromUserId.slice(0, 8)}] Error processing answer:`,
            err
          )
        }
      }
    }

    const socket = getFmSocket()
    return socket.subscribe((msg) => {
      if (msg.type !== 'webrtc_signal') return
      if (msg.fromUserId === userId) {
        console.warn('[SOCKET] Ignoring loopback signal from self')
        return
      }
      console.warn(`[SOCKET] Received webrtc_signal from ${msg.fromUserId.slice(0, 8)}`)
      void handleSignal(msg.fromUserId, msg.signalData)
    })
  }, [userId, setIncomingCall, flushPendingIce])

  const rejectIncomingCall = useCallback(() => {
    setIncomingCall(null)
  }, [setIncomingCall])

  const acceptIncomingCall = useCallback(async () => {
    const inc = useCallStore.getState().incomingCall
    if (!inc) return

    let stream: MediaStream | null = null
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('NO_MEDIA_API')
      }
      stream = await navigator.mediaDevices.getUserMedia(
        getUserMediaConstraints({ video: !!inc.isVideo })
      )
    } catch (err) {
      setMediaAccessError(
        isMediaPermissionDenied(err)
          ? MEDIA_PERMISSION_DENIED_CODE
          : MEDIA_ACCESS_ERROR_MESSAGE
      )
      setIncomingCall(null)
      return
    }

    setLocalStream(stream)
    if (inc.isVideo) facingModeRef.current = 'user'
    console.warn(
      `[ACCEPT←${inc.peerId.slice(0, 8)}] Creating PeerConnection for answer (video=${inc.isVideo})`
    )
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() })
    pcsRef.current.set(inc.peerId, pc)
    addPeerConnection(inc.peerId, pc)
    attachPeerHandlers(inc.peerId, pc)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    try {
      console.warn(
        `[ACCEPT←${inc.peerId.slice(0, 8)}] Setting remote description (offer sdp=${inc.offer.sdp?.length ?? 0} bytes)`
      )
      await pc.setRemoteDescription(inc.offer)
      console.warn(`[ACCEPT←${inc.peerId.slice(0, 8)}] Remote description set, flushing pending ICE candidates`)
      await flushPendingIce(inc.peerId, pc)
      console.warn(`[ACCEPT←${inc.peerId.slice(0, 8)}] Creating answer...`)
      const answer = await pc.createAnswer()
      console.warn(`[ACCEPT←${inc.peerId.slice(0, 8)}] Answer created (sdp=${answer.sdp?.length ?? 0} bytes)`)
      console.warn(`[ACCEPT←${inc.peerId.slice(0, 8)}] Setting local description...`)
      await pc.setLocalDescription(answer)
      console.warn(`[ACCEPT←${inc.peerId.slice(0, 8)}] Local description set, signaling answer`)
      sendSignal(inc.peerId, { kind: 'answer', sdp: answer.sdp ?? '' })
    } catch (err) {
      console.error(`[ACCEPT←${inc.peerId.slice(0, 8)}] Error accepting call:`, err)
      cleanupPeer(inc.peerId)
      stopStreamTracks(stream)
      setLocalStream(null)
      setIncomingCall(null)
      return
    }

    setIncomingCall(null)
    setIsCalling(true)
  }, [
    setLocalStream,
    addPeerConnection,
    attachPeerHandlers,
    flushPendingIce,
    cleanupPeer,
    setIncomingCall,
    setIsCalling,
  ])

  const initiateCall = useCallback(
    async (recipientIds: string[], isVideo: boolean) => {
      let stream: MediaStream
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('NO_MEDIA_API')
        }
        stream = await navigator.mediaDevices.getUserMedia(
          getUserMediaConstraints({ video: isVideo })
        )
      } catch (err) {
        setMediaAccessError(
          isMediaPermissionDenied(err)
            ? MEDIA_PERMISSION_DENIED_CODE
            : MEDIA_ACCESS_ERROR_MESSAGE
        )
        return
      }

      setLocalStream(stream)
      setIsCalling(true)
      if (isVideo) facingModeRef.current = 'user'

      for (const peerId of recipientIds) {
        if (peerId === userId) continue
        if (pcsRef.current.has(peerId)) continue

        console.warn(`[INIT→${peerId.slice(0, 8)}] Creating PeerConnection (video=${isVideo})`)
        const pc = new RTCPeerConnection({ iceServers: buildIceServers() })
        pcsRef.current.set(peerId, pc)
        addPeerConnection(peerId, pc)
        attachPeerHandlers(peerId, pc)
        stream.getTracks().forEach((t) => pc.addTrack(t, stream))

        try {
          console.warn(`[INIT→${peerId.slice(0, 8)}] Creating offer...`)
          const offer = await pc.createOffer()
          console.warn(`[INIT→${peerId.slice(0, 8)}] Offer created (sdp=${offer.sdp?.length ?? 0} bytes)`)
          console.warn(`[INIT→${peerId.slice(0, 8)}] Setting local description...`)
          await pc.setLocalDescription(offer)
          console.warn(`[INIT→${peerId.slice(0, 8)}] Local description set, signaling offer`)
          sendSignal(peerId, {
            kind: 'offer',
            sdp: offer.sdp ?? '',
            isVideo,
          })
        } catch (err) {
          console.error(`[INIT→${peerId.slice(0, 8)}] Error creating offer:`, err)
          cleanupPeer(peerId)
        }
      }

      outgoingRingStopRef.current?.()
      outgoingRingStopRef.current = null
      if (pcsRef.current.size > 0) {
        outgoingRingStopRef.current = startOutgoingRingtone()
      }

      if (pcsRef.current.size === 0) {
        stopStreamTracks(stream)
        resetCallStore()
      }
    },
    [
      userId,
      setLocalStream,
      setIsCalling,
      addPeerConnection,
      attachPeerHandlers,
      cleanupPeer,
      resetCallStore,
    ]
  )

  const toggleMuteMic = useCallback(() => {
    const s = useCallStore.getState().localStream
    if (!s) return
    s.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    const enabled = s.getAudioTracks()[0]?.enabled ?? true
    for (const peerId of Array.from(pcsRef.current.keys())) {
      sendSignal(peerId, { kind: 'media_state', media: 'audio', enabled })
    }
  }, [])

  const toggleCamera = useCallback(() => {
    const s = useCallStore.getState().localStream
    if (!s) return
    s.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    const vt = s.getVideoTracks()[0]
    const enabled = vt ? vt.enabled : false
    for (const peerId of Array.from(pcsRef.current.keys())) {
      sendSignal(peerId, { kind: 'media_state', media: 'video', enabled })
    }
  }, [])

  const switchCamera = useCallback(async () => {
    if (screenVideoTrackRef.current) return
    const local = useCallStore.getState().localStream
    if (!local || pcsRef.current.size === 0) return
    const oldVideo = local.getVideoTracks()[0]
    if (!oldVideo) return
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      return
    }

    facingModeRef.current =
      facingModeRef.current === 'user' ? 'environment' : 'user'
    const nextFacing = facingModeRef.current

    try {
      const base = getUserMediaConstraints({ video: true })
      const fromPrefs: MediaTrackConstraints =
        base.video && typeof base.video === 'object'
          ? { ...(base.video as MediaTrackConstraints) }
          : {}
      // Pinning `deviceId` conflicts with toggling by facing mode — drop it for this swap.
      delete (fromPrefs as { deviceId?: unknown }).deviceId

      const videoConstraints: MediaTrackConstraints = isIOSOrIPadOS()
        ? {
            ...fromPrefs,
            facingMode: { ideal: nextFacing },
          }
        : {
            ...fromPrefs,
            facingMode: { ideal: nextFacing },
            width: { ideal: 720 },
            height: { ideal: 720 },
          }

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints,
      })
      const newTrack = newStream.getVideoTracks()[0]
      if (!newTrack) {
        facingModeRef.current = nextFacing === 'user' ? 'environment' : 'user'
        newStream.getTracks().forEach((t) => t.stop())
        return
      }

      for (const [, pc] of pcsRef.current) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) void sender.replaceTrack(newTrack)
      }

      local.removeTrack(oldVideo)
      oldVideo.stop()
      local.addTrack(newTrack)
      newStream.getAudioTracks().forEach((t) => t.stop())
      setLocalStream(local)
    } catch {
      facingModeRef.current = nextFacing === 'user' ? 'environment' : 'user'
    }
  }, [setLocalStream])

  const toggleScreenShare = useCallback(async () => {
    if (screenVideoTrackRef.current) {
      revertToCamera()
      return
    }

    /** Mobile Chrome/Firefox: getDisplayMedia is unsupported or unusable — avoid NotAllowedError noise. */
    if (isAndroidMobile()) {
      return
    }

    const local = useCallStore.getState().localStream
    if (!local || pcsRef.current.size === 0) return

    const camTrack = local.getVideoTracks()[0]
    if (!camTrack) return

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      return
    }

    let screenStream: MediaStream
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
    } catch {
      return
    }

    const screenTrack = screenStream.getVideoTracks()[0]
    if (!screenTrack) {
      screenStream.getTracks().forEach((t) => t.stop())
      return
    }

    if (
      pcsRef.current.size === 0 ||
      !useCallStore.getState().isCalling ||
      useCallStore.getState().localStream !== local
    ) {
      screenTrack.stop()
      return
    }

    originalVideoTrackRef.current = camTrack
    screenVideoTrackRef.current = screenTrack

    for (const [, pc] of pcsRef.current) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) {
        void sender.replaceTrack(screenTrack)
      }
    }

    local.removeTrack(camTrack)
    local.addTrack(screenTrack)
    setLocalStream(local)
    setIsScreenSharing(true)

    screenTrack.onended = () => {
      revertToCameraRef.current()
    }
  }, [revertToCamera, setLocalStream])

  const clearMediaAccessError = useCallback(() => {
    setMediaAccessError(null)
  }, [])

  return {
    peerReady,
    mediaAccessError,
    clearMediaAccessError,
    initiateCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMuteMic,
    toggleCamera,
    switchCamera,
    isScreenSharing,
    toggleScreenShare,
  }
}

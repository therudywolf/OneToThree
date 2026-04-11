'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { startOutgoingRingtone } from '@/lib/call-ringtones'
import { getUserMediaConstraints } from '@/lib/media-devices'
import {
  isMediaPermissionDenied,
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
} from '@/lib/media-limits'
import { useCallStore } from '@/store/callStore'
import { useChatStore } from '@/store/chatStore'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

function stopStreamTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

type SignalPayload =
  | { kind: 'offer'; sdp: string; isVideo?: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null }

function sendSignal(targetUserId: string, signalData: SignalPayload) {
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

  const flushPendingIce = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const q = pendingIceRef.current[peerId]
    if (!q?.length) return
    for (const c of q) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
    delete pendingIceRef.current[peerId]
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
      const pc = pcsRef.current.get(peerId)
      if (pc) {
        pc.close()
        pcsRef.current.delete(peerId)
      }
      removePeerConnection(peerId)
      removeRemoteStream(peerId)
      delete pendingIceRef.current[peerId]
    },
    [removePeerConnection, removeRemoteStream, clearIceDisconnectTimer]
  )

  const maybeResetCallIfNoPeers = useCallback(() => {
    if (pcsRef.current.size > 0) return
    outgoingRingStopRef.current?.()
    outgoingRingStopRef.current = null
    const state = useCallStore.getState()
    if (
      state.isCalling ||
      state.incomingCall != null ||
      state.localStream != null
    ) {
      stopStreamTracks(state.localStream)
      resetCallStore()
    }
  }, [resetCallStore])

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

  useEffect(() => {
    revertToCameraRef.current = revertToCamera
  }, [revertToCamera])

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
    stopStreamTracks(useCallStore.getState().localStream)
    resetCallStore()
  }, [cleanupPeer, resetCallStore, revertToCamera])

  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    return socket.subscribe((msg) => {
      if (msg.type === 'call_invite') {
        const state = useCallStore.getState()
        if (state.isCalling || state.incomingCall) return
        setIncomingCall({
          peerId: msg.from_user_id,
          isVideo: msg.is_video,
          offer: { type: 'offer', sdp: '' },
        })
      }
      if (msg.type === 'call_leave') {
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
        if (st === 'connected' || st === 'completed') {
          clearIceDisconnectTimer(peerId)
          outgoingRingStopRef.current?.()
          outgoingRingStopRef.current = null
          return
        }
        if (st === 'failed' || st === 'closed') {
          clearIceDisconnectTimer(peerId)
          teardownIfStillThisPc()
          return
        }
        if (st === 'disconnected') {
          clearIceDisconnectTimer(peerId)
          const timerId = window.setTimeout(() => {
            iceDisconnectTimersRef.current.delete(peerId)
            if (pcsRef.current.get(peerId) !== pc) return
            if (pc.iceConnectionState !== 'disconnected') return
            teardownIfStillThisPc()
          }, 3200)
          iceDisconnectTimersRef.current.set(peerId, timerId)
        }
      }

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState
        if (st === 'failed' || st === 'closed') {
          clearIceDisconnectTimer(peerId)
          teardownIfStillThisPc()
        }
      }
      pc.ontrack = (ev) => {
        if (ev.streams[0]) {
          setRemoteStream(peerId, ev.streams[0])
        }
      }
      pc.onicecandidate = (ev) => {
        // WARNING: ICE candidate routing must stay peer-targeted.
        // Broadcasting candidates to non-target peers can leak network metadata
        // and break connection establishment in full-mesh calls.
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
      if (!isSignalPayload(raw)) return
      const data = raw

      if (data.kind === 'ice') {
        const pc = pcsRef.current.get(fromUserId)
        if (data.candidate && pc) {
          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(data.candidate)
            } catch {
              /* ignore */
            }
          } else {
            const bucket = pendingIceRef.current[fromUserId] ?? []
            bucket.push(data.candidate)
            pendingIceRef.current[fromUserId] = bucket
          }
        }
        return
      }

      if (data.kind === 'offer') {
        if (pcsRef.current.has(fromUserId)) {
          return
        }
        const state = useCallStore.getState()
        if (state.incomingCall?.peerId === fromUserId) {
          return
        }
        if (state.isCalling) {
          return
        }
        setIncomingCall({
          peerId: fromUserId,
          isVideo: !!data.isVideo,
          offer: { type: 'offer', sdp: data.sdp },
        })
        return
      }

      if (data.kind === 'answer') {
        const pc = pcsRef.current.get(fromUserId)
        if (!pc) return
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
          await flushPendingIce(fromUserId, pc)
        } catch {
          /* ignore */
        }
      }
    }

    const socket = getFmSocket()
    return socket.subscribe((msg) => {
      if (msg.type !== 'webrtc_signal') return
      if (msg.fromUserId === userId) return
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
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcsRef.current.set(inc.peerId, pc)
    addPeerConnection(inc.peerId, pc)
    attachPeerHandlers(inc.peerId, pc)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    try {
      await pc.setRemoteDescription(inc.offer)
      await flushPendingIce(inc.peerId, pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      sendSignal(inc.peerId, { kind: 'answer', sdp: answer.sdp ?? '' })
    } catch {
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

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
        pcsRef.current.set(peerId, pc)
        addPeerConnection(peerId, pc)
        attachPeerHandlers(peerId, pc)
        stream.getTracks().forEach((t) => pc.addTrack(t, stream))

        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal(peerId, {
            kind: 'offer',
            sdp: offer.sdp ?? '',
            isVideo,
          })
        } catch {
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
    s?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
  }, [])

  const toggleCamera = useCallback(() => {
    const s = useCallStore.getState().localStream
    s?.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
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
      const fromPrefs =
        base.video && typeof base.video === 'object'
          ? (base.video as MediaTrackConstraints)
          : {}

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...fromPrefs,
          facingMode: nextFacing,
          width: { ideal: 720 },
          height: { ideal: 720 },
        },
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

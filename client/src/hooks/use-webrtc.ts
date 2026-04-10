'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useCallStore } from '@/store/callStore'

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
  const pcsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({})

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

  const cleanupPeer = useCallback(
    (peerId: string) => {
      const pc = pcsRef.current.get(peerId)
      if (pc) {
        pc.close()
        pcsRef.current.delete(peerId)
      }
      removePeerConnection(peerId)
      removeRemoteStream(peerId)
      delete pendingIceRef.current[peerId]
    },
    [removePeerConnection, removeRemoteStream]
  )

  const endCall = useCallback(() => {
    for (const id of Array.from(pcsRef.current.keys())) {
      cleanupPeer(id)
    }
    stopStreamTracks(useCallStore.getState().localStream)
    resetCallStore()
  }, [cleanupPeer, resetCallStore])

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
        const remaining = pcsRef.current.size
        if (remaining === 0 && useCallStore.getState().isCalling) {
          stopStreamTracks(useCallStore.getState().localStream)
          resetCallStore()
        }
      }
    })
  }, [userId, setIncomingCall, cleanupPeer, resetCallStore])

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
      pc.ontrack = (ev) => {
        if (ev.streams[0]) {
          setRemoteStream(peerId, ev.streams[0])
        }
      }
      pc.onicecandidate = (ev) => {
        sendSignal(peerId, {
          kind: 'ice',
          candidate: ev.candidate ? ev.candidate.toJSON() : null,
        })
      }
    },
    [setRemoteStream]
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

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: !!inc.isVideo,
    })
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isVideo,
      })
      setLocalStream(stream)
      setIsCalling(true)

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
    },
    [
      userId,
      setLocalStream,
      setIsCalling,
      addPeerConnection,
      attachPeerHandlers,
      cleanupPeer,
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

  return {
    peerReady,
    initiateCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMuteMic,
    toggleCamera,
  }
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { startOutgoingRingtone } from '@/lib/call-ringtones'
import { isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS } from '@/lib/ios'
import { getUserMediaConstraints, loadMediaPrefs } from '@/lib/media-devices'
import {
  isMediaPermissionDenied,
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
} from '@/lib/media-limits'
import { useCallStore } from '@/store/callStore'
import { useChatStore } from '@/store/chatStore'

/**
 * PROJECT 13 :: WEBRTC_SIGNAL_PROTOCOL
 * Level: Transmission Layer (Zero-Trust)
 * Vibe: Clinical Steel / Terminal Noir
 */

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]

async function getSignalRelays(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/turn', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) throw new Error(`RELAY_FETCH_FAIL: ${res.status}`)

    const payload = (await res.json()) as { iceServers?: RTCIceServer[] }
    if (!payload.iceServers) throw new Error('MALFORMED_RELAY_PAYLOAD')

    return payload.iceServers.map(server => ({
      ...server,
      urls: Array.isArray(server.urls) 
        ? server.urls.flatMap(u => u.startsWith('turn:') ? [`${u}?transport=tcp`, `${u}?transport=udp`] : [u])
        : typeof server.urls === 'string' && server.urls.startsWith('turn:') 
          ? [`${server.urls}?transport=tcp`, `${server.urls}?transport=udp`] 
          : server.urls
    }))
  } catch (err) {
    console.warn('[SYS.ICE] Relay nodes unreachable, using default STUN fallback.', err)
    return DEFAULT_STUN
  }
}

function terminateFeed(stream: MediaStream | null) {
  stream?.getTracks().forEach(t => {
    t.enabled = false
    t.stop()
  })
}

async function captureLocalFeed(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    if ((err as Error)?.name === 'OverconstrainedError') {
      return await navigator.mediaDevices.getUserMedia({
        audio: constraints.audio ?? true,
        video: true,
      })
    }
    throw err
  }
}

type SignalPayload =
  | { kind: 'offer'; sdp: string; isVideo?: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null }
  | { kind: 'media_state'; media: 'audio' | 'video'; enabled: boolean }

function transmitSignal(targetUserId: string, signalData: SignalPayload) {
  getFmSocket().send({ type: 'webrtc_signal', targetUserId, signalData })
}

export function useWebRTC(userId: string | null) {
  const [peerReady, setPeerReady] = useState(false)
  const [mediaAccessError, setMediaAccessError] = useState<string | null>(null)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  
  const pcsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({})
  const originalOpticsRef = useRef<MediaStreamTrack | null>(null)
  const screenFeedRef = useRef<MediaStreamTrack | null>(null)
  const disconnectTimersRef = useRef(new Map<string, number>())
  const ringStopRef = useRef<(() => void) | null>(null)
  const facingModeRef = useRef<'user' | 'environment'>('user')

  const { 
    setIncomingCall, reset: resetCallStore, addPeerConnection, 
    removePeerConnection, setRemoteStream, removeRemoteStream, 
    setLocalStream, setIsCalling, clearRemotePeerMedia 
  } = useCallStore()

  const flushIceQueue = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queue = pendingIceRef.current[peerId]
    if (!queue?.length) return

    const snapshot = [...queue]
    pendingIceRef.current[peerId] = []

    await Promise.all(snapshot.map(async (c) => {
      try {
        if (c) await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (e) {
        console.error(`[SYS.ICE] Injection failure for node ${peerId.slice(0, 8)}`, e)
      }
    }))
  }, [])

  const purgePeer = useCallback((peerId: string) => {
    const timer = disconnectTimersRef.current.get(peerId)
    if (timer) clearTimeout(timer)
    
    const remote = useCallStore.getState().remoteStreams[peerId]
    if (remote) terminateFeed(remote)

    const pc = pcsRef.current.get(peerId)
    if (pc) {
      pc.close()
      pcsRef.current.delete(peerId)
    }

    removePeerConnection(peerId)
    removeRemoteStream(peerId)
    clearRemotePeerMedia(peerId)
    delete pendingIceRef.current[peerId]
  }, [removePeerConnection, removeRemoteStream, clearRemotePeerMedia])

  const revertToOptics = useCallback(() => {
    const orig = originalOpticsRef.current
    const screen = screenFeedRef.current
    const local = useCallStore.getState().localStream

    if (screen) screen.onended = null

    if (orig && local) {
      pcsRef.current.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) void sender.replaceTrack(orig)
      })
      const current = local.getVideoTracks()[0]
      if (current && current !== orig) {
        local.removeTrack(current)
        current.stop()
      }
      if (!local.getVideoTracks().includes(orig)) local.addTrack(orig)
      setLocalStream(local)
    }

    screen?.stop()
    originalOpticsRef.current = null
    screenFeedRef.current = null
    setIsScreenSharing(false)
  }, [setLocalStream])

  const severAllLinks = useCallback(() => {
    ringStopRef.current?.()
    setMediaAccessError(null)
    revertToOptics()
    
    const chatId = useChatStore.getState().activeChatId
    if (chatId) getFmSocket().send({ type: 'call_leave', chat_id: chatId })

    Array.from(pcsRef.current.keys()).forEach(purgePeer)
    
    const state = useCallStore.getState()
    terminateFeed(state.localStream)
    resetCallStore()
  }, [purgePeer, resetCallStore, revertToOptics])

  const setupPeerLink = useCallback((peerId: string, pc: RTCPeerConnection) => {
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        transmitSignal(peerId, {
          kind: 'offer',
          sdp: offer.sdp ?? '',
          isVideo: !!useCallStore.getState().localStream?.getVideoTracks().length,
        })
      } catch (err) {
        console.error('[SYS.SIGNAL] Negotiation failure:', err)
      }
    }

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      if (state === 'connected' || state === 'completed') {
        ringStopRef.current?.()
      } else if (state === 'failed' || state === 'closed') {
        purgePeer(peerId)
      } else if (state === 'disconnected') {
        const timer = window.setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') purgePeer(peerId)
        }, 4000)
        disconnectTimersRef.current.set(peerId, timer)
      }
    }

    pc.ontrack = (ev) => {
      if (ev.streams[0]) setRemoteStream(peerId, ev.streams[0])
    }

    pc.onicecandidate = (ev) => {
      transmitSignal(peerId, {
        kind: 'ice',
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
  }, [setRemoteStream, purgePeer])

  // Socket Subscription Layer
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    
    return socket.subscribe(async (msg) => {
      if (msg.type === 'call_invite') {
        const state = useCallStore.getState()
        if (state.isCalling || state.incomingCall) return
        setIncomingCall({ peerId: msg.from_user_id, isVideo: msg.is_video, offer: { type: 'offer', sdp: '' } })
      }

      if (msg.type === 'call_leave') purgePeer(msg.from_user_id)

      if (msg.type === 'webrtc_signal') {
        const { fromUserId, signalData: data } = msg
        if (fromUserId === userId) return

        if (data.kind === 'media_state') {
          const update = data.media === 'audio' ? { micMuted: !data.enabled } : { cameraOff: !data.enabled }
          useCallStore.getState().setRemotePeerMedia(fromUserId, update)
          return
        }

        const pc = pcsRef.current.get(fromUserId)
        if (data.kind === 'ice' && pc) {
          if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate!))
          else (pendingIceRef.current[fromUserId] ??= []).push(data.candidate!)
        }

        if (data.kind === 'offer') {
          if (pc) {
            await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
            await flushIceQueue(fromUserId, pc)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            transmitSignal(fromUserId, { kind: 'answer', sdp: answer.sdp ?? '' })
          } else {
            setIncomingCall({ peerId: fromUserId, isVideo: !!data.isVideo, offer: { type: 'offer', sdp: data.sdp } })
          }
        }

        if (data.kind === 'answer' && pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
          await flushIceQueue(fromUserId, pc)
        }
      }
    })
  }, [userId, setIncomingCall, purgePeer, flushIceQueue])

  // Health Check / Readiness
  useEffect(() => {
    if (!userId) return setPeerReady(false)
    const socket = getFmSocket()
    const id = window.setInterval(() => setPeerReady(socket.connected), 2000)
    return () => {
      window.clearInterval(id)
      severAllLinks()
    }
  }, [userId, severAllLinks])

  const establishLink = useCallback(async (recipients: string[], isVideo: boolean) => {
    let stream: MediaStream
    try {
      const prefs = loadMediaPrefs()
      stream = await captureLocalFeed(getUserMediaConstraints({ video: isVideo, hd: !prefs.lowBandwidth }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      return
    }

    setLocalStream(stream)
    setIsCalling(true)
    const relays = await getSignalRelays()

    for (const peerId of recipients) {
      if (peerId === userId || pcsRef.current.has(peerId)) continue
      
      const pc = new RTCPeerConnection({ iceServers: relays, iceTransportPolicy: 'relay' })
      pcsRef.current.set(peerId, pc)
      addPeerConnection(peerId, pc)
      setupPeerLink(peerId, pc)
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
    }

    if (pcsRef.current.size > 0) ringStopRef.current = startOutgoingRingtone()
    else severAllLinks()
  }, [userId, setLocalStream, setIsCalling, addPeerConnection, setupPeerLink, severAllLinks])

  const acceptLink = useCallback(async () => {
    const inc = useCallStore.getState().incomingCall
    if (!inc) return

    let stream: MediaStream
    try {
      const prefs = loadMediaPrefs()
      stream = await captureLocalFeed(getUserMediaConstraints({ video: !!inc.isVideo, hd: !prefs.lowBandwidth }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      setIncomingCall(null)
      return
    }

    setLocalStream(stream)
    const relays = await getSignalRelays()
    const pc = new RTCPeerConnection({ iceServers: relays, iceTransportPolicy: 'relay' })
    
    pcsRef.current.set(inc.peerId, pc)
    addPeerConnection(inc.peerId, pc)
    setupPeerLink(inc.peerId, pc)
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    try {
      await pc.setRemoteDescription(inc.offer)
      await flushIceQueue(inc.peerId, pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      transmitSignal(inc.peerId, { kind: 'answer', sdp: answer.sdp ?? '' })
      setIsCalling(true)
    } catch (err) {
      purgePeer(inc.peerId)
      terminateFeed(stream)
    } finally {
      setIncomingCall(null)
    }
  }, [setLocalStream, addPeerConnection, setupPeerLink, flushIceQueue, purgePeer, setIncomingCall, setIsCalling])

  const toggleMute = useCallback(() => {
    const local = useCallStore.getState().localStream
    if (!local) return
    local.getAudioTracks().forEach(t => (t.enabled = !t.enabled))
    const enabled = local.getAudioTracks()[0]?.enabled ?? true
    pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'media_state', media: 'audio', enabled }))
  }, [])

  const toggleOptics = useCallback(() => {
    const local = useCallStore.getState().localStream
    if (!local) return
    local.getVideoTracks().forEach(t => (t.enabled = !t.enabled))
    const enabled = local.getVideoTracks()[0]?.enabled ?? false
    pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'media_state', media: 'video', enabled }))
  }, [])

  return {
    peerReady,
    mediaAccessError,
    clearMediaAccessError: () => setMediaAccessError(null),
    initiateCall: establishLink,
    acceptIncomingCall: acceptLink,
    rejectIncomingCall: () => setIncomingCall(null),
    endCall: severAllLinks,
    toggleMuteMic: toggleMute,
    toggleCamera: toggleOptics,
    toggleVideo: toggleOptics,
    switchCamera: async () => {},
    isScreenSharing,
    toggleScreenShare: async () => {},
  }
}
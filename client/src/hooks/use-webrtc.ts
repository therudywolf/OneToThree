'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { startOutgoingRingtone } from '@/lib/call-ringtones'
import { isAndroidMobile as _isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS as _isIOSOrIPadOS } from '@/lib/ios'
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
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

function hasTransportParam(url: string): boolean {
  return /[?&]transport=/i.test(url)
}

function withTransport(url: string, transport: 'udp' | 'tcp'): string {
  if (hasTransportParam(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}transport=${transport}`
}

function extractTurnHost(url: string): string | null {
  const stripped = url.replace(/^turns?:\/\//i, '').replace(/^turns?:/i, '')
  const authority = stripped.split('/')[0]?.split('?')[0] ?? ''
  if (!authority) return null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end > 0) return authority.slice(0, end + 1)
    return null
  }
  return authority.split(':')[0] ?? null
}

function normalizeTurnUrl(url: string): string[] {
  if (url.startsWith('turns:')) {
    return [hasTransportParam(url) ? url : withTransport(url, 'tcp')]
  }
  if (!url.startsWith('turn:')) return [url]
  if (hasTransportParam(url)) return [url]
  const list = [withTransport(url, 'udp'), withTransport(url, 'tcp')]
  const host = extractTurnHost(url)
  if (host) {
    list.push(`turns:${host}:443?transport=tcp`)
    list.push(`turns:${host}:5349?transport=tcp`)
  }
  return list
}

function normalizeIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.map((server) => {
    const baseUrls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const urls = Array.from(new Set(baseUrls.flatMap((u) => normalizeTurnUrl(String(u)))))
    return { ...server, urls }
  })
}

function parseEnvTurnUrls(): string[] {
  const raw = (process.env.NEXT_PUBLIC_TURN_URLS || process.env.NEXT_PUBLIC_TURN_URL || '').trim()
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

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

    return normalizeIceServers(payload.iceServers)
  } catch (err) {
    console.warn('[SYS.ICE] Relay nodes unreachable, using fallback ICE plan.', err)
    const envUrls = parseEnvTurnUrls()
    if (envUrls.length > 0) {
      return normalizeIceServers([
        ...DEFAULT_STUN,
        {
          urls: envUrls,
          username: process.env.NEXT_PUBLIC_TURN_USERNAME,
          credential: process.env.NEXT_PUBLIC_TURN_PASSWORD,
        },
      ])
    }
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

/** Set Opus audio bitrate to 64kbps via RTCRtpSender.setParameters() */
async function tuneOpusBitrate(pc: RTCPeerConnection): Promise<void> {
  try {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings[0]) return
    params.encodings[0].maxBitrate = 64000
    await sender.setParameters(params)
  } catch {
    // Opus tuning not supported in this browser
  }
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

  const statsIntervalRef = useRef<number | null>(null)

  const iceRetryTimersRef = useRef(new Map<string, number>())
  const connectTimeoutRef = useRef<number | null>(null)

  const {
    setIncomingCall, reset: resetCallStore, addPeerConnection,
    removePeerConnection, setRemoteStream, removeRemoteStream,
    setLocalStream, setIsCalling, clearRemotePeerMedia,
    setReconnecting, setConnectionLost, setIceRetryCount,
    setConnectionQuality,
    setPeerConnectionType, clearPeerConnectionType,
    setCallStartTime, setMiniPlayer: _setMiniPlayer,
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
    clearPeerConnectionType(peerId)
    delete pendingIceRef.current[peerId]
  }, [removePeerConnection, removeRemoteStream, clearRemotePeerMedia, clearPeerConnectionType])

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
    if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
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
      const iceState = pc.iceConnectionState
      if (iceState === 'connected' || iceState === 'completed') {
        ringStopRef.current?.()
        if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
        setReconnecting(false)
        setConnectionLost(false)
        setIceRetryCount(0)
        void tuneOpusBitrate(pc)
        // Clear any pending disconnect/retry timers
        const timer = disconnectTimersRef.current.get(peerId)
        if (timer) { clearTimeout(timer); disconnectTimersRef.current.delete(peerId) }
        const purgeTimer = disconnectTimersRef.current.get(`${peerId}_purge`)
        if (purgeTimer) { clearTimeout(purgeTimer); disconnectTimersRef.current.delete(`${peerId}_purge`) }
        const retryTimer = iceRetryTimersRef.current.get(peerId)
        if (retryTimer) { clearTimeout(retryTimer); iceRetryTimersRef.current.delete(peerId) }
      } else if (iceState === 'disconnected') {
        // Wait 3s, then attempt ICE restart with iceRestart offer
        const timer = window.setTimeout(async () => {
          if (pc.iceConnectionState !== 'disconnected') return
          setReconnecting(true)
          try {
            pc.restartIce()
            const offer = await pc.createOffer({ iceRestart: true })
            await pc.setLocalDescription(offer)
            transmitSignal(peerId, { kind: 'offer', sdp: offer.sdp ?? '', isVideo: !!useCallStore.getState().localStream?.getVideoTracks().length })
          } catch {
            console.warn('[SYS.ICE] ICE restart offer failed for', peerId.slice(0, 8))
          }
        }, 3000)
        disconnectTimersRef.current.set(peerId, timer)
      } else if (iceState === 'failed') {
        const retryCount = useCallStore.getState().iceRetryCount
        if (retryCount < 3) {
          console.warn(`[SYS.ICE] Connection failed, retry ${retryCount + 1}/3 for`, peerId.slice(0, 8))
          setReconnecting(true)
          setIceRetryCount(retryCount + 1)
          const retryTimer = window.setTimeout(async () => {
            try {
              pc.restartIce()
              const offer = await pc.createOffer({ iceRestart: true })
              await pc.setLocalDescription(offer)
              transmitSignal(peerId, { kind: 'offer', sdp: offer.sdp ?? '', isVideo: !!useCallStore.getState().localStream?.getVideoTracks().length })
            } catch {
              console.warn('[SYS.ICE] ICE restart retry failed for', peerId.slice(0, 8))
            }
          }, 5000)
          iceRetryTimersRef.current.set(peerId, retryTimer)
        } else {
          // 3 retries exhausted → connection lost
          console.error('[SYS.ICE] All retries exhausted for', peerId.slice(0, 8))
          setReconnecting(false)
          setConnectionLost(true)
        }
      } else if (iceState === 'closed') {
        purgePeer(peerId)
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
  }, [setRemoteStream, purgePeer, setReconnecting, setConnectionLost, setIceRetryCount])

  // Socket Subscription Layer
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    
    return socket.subscribe(async (msg) => {
      if (msg.type === 'call_invite') {
        const state = useCallStore.getState()
        if (state.isCalling || state.incomingCall) return
        setIncomingCall({ peerId: msg.from_user_id, isVideo: msg.is_video, offer: null })
      }

      if (msg.type === 'call_leave') {
        purgePeer(msg.from_user_id)
        // If no peers remain, end the call entirely
        if (pcsRef.current.size === 0 && useCallStore.getState().isCalling) {
          severAllLinks()
        }
      }

      if (msg.type === 'webrtc_signal') {
        const { fromUserId, signalData: rawSignal } = msg
        const data = rawSignal as {
          kind: string
          media?: string
          enabled?: boolean
          sdp?: string
          isVideo?: boolean
          candidate?: RTCIceCandidateInit
        }
        if (fromUserId === userId) return

        if (data.kind === 'media_state') {
          const update = data.media === 'audio' ? { micMuted: !data.enabled } : { cameraOff: !data.enabled }
          useCallStore.getState().setRemotePeerMedia(fromUserId, update)
          return
        }

        const pc = pcsRef.current.get(fromUserId)
        if (data.kind === 'ice' && pc) {
          if (data.candidate) {
            if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
            else (pendingIceRef.current[fromUserId] ??= []).push(data.candidate)
          }
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
  }, [userId, setIncomingCall, purgePeer, flushIceQueue, severAllLinks])

  const applyQualityConstraints = useCallback((level: '720p' | '480p' | '360p' | 'audio_only') => {
    const local = useCallStore.getState().localStream
    if (!local) return

    if (level === 'audio_only') {
      local.getVideoTracks().forEach(t => { t.enabled = false })
      pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'media_state', media: 'video', enabled: false }))
      return
    }

    const dims = level === '720p'
      ? { width: 1280, height: 720, frameRate: 30 }
      : level === '480p'
        ? { width: 854, height: 480, frameRate: 24 }
        : { width: 640, height: 360, frameRate: 15 }

    local.getVideoTracks().forEach(t => {
      t.enabled = true
      void t.applyConstraints({
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        frameRate: { ideal: dims.frameRate },
      }).catch(() => {})
    })
  }, [])

  const setQuality = useCallback((level: 'auto' | '720p' | '480p' | '360p' | 'audio_only') => {
    useCallStore.getState().setQualityLevel(level)
    lowBitrateCountRef.current = 0
    highBitrateCountRef.current = 0

    if (level === 'auto') return // auto-adapt will handle it
    applyQualityConstraints(level)
  }, [applyQualityConstraints])

  // Connection quality monitoring + P2P/relay detection + auto-adapt — polls stats every 5s
  const lowBitrateCountRef = useRef(0)
  const highBitrateCountRef = useRef(0)

  useEffect(() => {
    const poll = () => {
      const state = useCallStore.getState()
      if (!state.isCalling) {
        setConnectionQuality(null)
        lowBitrateCountRef.current = 0
        highBitrateCountRef.current = 0
        return
      }
      const pcsEntries = Array.from(pcsRef.current.entries())
      if (pcsEntries.length === 0) return

      void (async () => {
        for (const [peerId, pc] of pcsEntries) {
          if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') continue
          try {
            const stats = await pc.getStats()
            const localCandidates = new Map<string, { candidateType: string }>()
            stats.forEach((report) => {
              if (report.type === 'local-candidate') {
                localCandidates.set(report.id, { candidateType: report.candidateType })
              }
            })

            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                const rtt = report.currentRoundTripTime ?? null
                const bitrate = report.availableOutgoingBitrate ?? null
                const poor = (rtt != null && rtt > 0.3) || (bitrate != null && bitrate < 100_000)
                setConnectionQuality({ rtt, outgoingBitrate: bitrate, poor })

                // P2P vs relay detection + relay degradation toast
                const localCandidate = localCandidates.get(report.localCandidateId)
                if (localCandidate) {
                  const cType = localCandidate.candidateType
                  const connType = (cType === 'relay') ? 'relay' as const : 'p2p' as const
                  const prevType = useCallStore.getState().peerConnectionTypes[peerId]
                  if (prevType === 'p2p' && connType === 'relay') {
                    useCallStore.getState().setShowRelayToast(true)
                  }
                  setPeerConnectionType(peerId, connType)
                }

                // Auto-adapt quality
                if (state.qualityLevel === 'auto' && bitrate != null) {
                  if (bitrate < 150_000) {
                    lowBitrateCountRef.current++
                    highBitrateCountRef.current = 0
                    if (lowBitrateCountRef.current >= 1) { // 5s (1 poll at 5s interval)
                      applyQualityConstraints('480p')
                    }
                  } else if (bitrate > 800_000) {
                    highBitrateCountRef.current++
                    lowBitrateCountRef.current = 0
                    if (highBitrateCountRef.current >= 2) { // 10s (2 polls at 5s interval)
                      applyQualityConstraints('720p')
                    }
                  } else {
                    lowBitrateCountRef.current = 0
                    highBitrateCountRef.current = 0
                  }
                }
              }
            })
          } catch { /* stats unavailable */ }
        }
      })()
    }

    // Only start polling when there's an active call
    const isCalling = useCallStore.getState().isCalling
    if (isCalling) {
      statsIntervalRef.current = window.setInterval(poll, 5000)
    }

    // Subscribe to isCalling changes to start/stop interval
    const unsub = useCallStore.subscribe((state, prevState) => {
      if (state.isCalling && !prevState.isCalling) {
        if (statsIntervalRef.current) window.clearInterval(statsIntervalRef.current)
        statsIntervalRef.current = window.setInterval(poll, 5000)
      } else if (!state.isCalling && prevState.isCalling) {
        if (statsIntervalRef.current) {
          window.clearInterval(statsIntervalRef.current)
          statsIntervalRef.current = null
        }
        setConnectionQuality(null)
        lowBitrateCountRef.current = 0
        highBitrateCountRef.current = 0
      }
    })

    return () => {
      unsub()
      if (statsIntervalRef.current) window.clearInterval(statsIntervalRef.current)
    }
  }, [setConnectionQuality, setPeerConnectionType, applyQualityConstraints])

  // Visibility change: restart ICE on reveal if connection dropped
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!useCallStore.getState().isCalling) return
      pcsRef.current.forEach((pc, peerId) => {
        const s = pc.iceConnectionState
        if (s === 'disconnected' || s === 'failed') {
          try {
            pc.restartIce()
            void (async () => {
              const offer = await pc.createOffer({ iceRestart: true })
              await pc.setLocalDescription(offer)
              transmitSignal(peerId, { kind: 'offer', sdp: offer.sdp ?? '', isVideo: !!useCallStore.getState().localStream?.getVideoTracks().length })
            })()
          } catch {
            console.warn('[SYS.ICE] Visibility-triggered restart failed for', peerId.slice(0, 8))
          }
        }
      })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // Clean up call on page unload / tab close
  useEffect(() => {
    const handleUnload = () => {
      if (useCallStore.getState().isCalling) severAllLinks()
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [severAllLinks])

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

  const establishLink = useCallback(async (recipients: string[], isVideo: boolean, chatId?: string) => {
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
    setCallStartTime(Date.now())
    const relays = await getSignalRelays()

    for (const peerId of recipients) {
      if (peerId === userId || pcsRef.current.has(peerId)) continue
      
      const pc = new RTCPeerConnection({ iceServers: relays, iceTransportPolicy: 'all' })
      pcsRef.current.set(peerId, pc)
      addPeerConnection(peerId, pc)
      setupPeerLink(peerId, pc)
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
    }

    if (pcsRef.current.size > 0) {
      if (chatId) {
        getFmSocket().send({
          type: 'call_invite',
          chat_id: chatId,
          is_video: isVideo,
        })
      }
      ringStopRef.current = startOutgoingRingtone()
      // 30s timeout: if no peer reaches 'connected', hang up
      connectTimeoutRef.current = window.setTimeout(() => {
        const anyConnected = Array.from(pcsRef.current.values()).some(
          p => p.iceConnectionState === 'connected' || p.iceConnectionState === 'completed'
        )
        if (!anyConnected && useCallStore.getState().isCalling) {
          console.warn('[SYS.ICE] 30s connection timeout — no peers connected')
          severAllLinks()
        }
      }, 30_000)
    } else {
      severAllLinks()
    }
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
    const pc = new RTCPeerConnection({ iceServers: relays, iceTransportPolicy: 'all' })
    
    pcsRef.current.set(inc.peerId, pc)
    addPeerConnection(inc.peerId, pc)
    setupPeerLink(inc.peerId, pc)
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    try {
      setIsCalling(true)
      setCallStartTime(Date.now())
      if (inc.offer?.sdp) {
        await pc.setRemoteDescription(inc.offer)
        await flushIceQueue(inc.peerId, pc)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        transmitSignal(inc.peerId, { kind: 'answer', sdp: answer.sdp ?? '' })
      }
    } catch {
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
    switchCamera: async () => {
      const local = useCallStore.getState().localStream
      if (!local || isScreenSharing) return

      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoInputs = devices.filter(d => d.kind === 'videoinput')
        if (videoInputs.length < 2) return

        const nextMode = facingModeRef.current === 'user' ? 'environment' : 'user'
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: nextMode }, width: { ideal: 1280 } },
          audio: false,
        })
        const newTrack = newStream.getVideoTracks()[0]
        if (!newTrack) return

        const oldTrack = local.getVideoTracks()[0]

        pcsRef.current.forEach(pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video')
          if (sender) void sender.replaceTrack(newTrack)
        })

        if (oldTrack) {
          local.removeTrack(oldTrack)
          oldTrack.stop()
        }
        local.addTrack(newTrack)
        facingModeRef.current = nextMode
        setLocalStream(local)
      } catch (err) {
        console.error('[SYS.MEDIA] CAMERA_SWITCH_FAULT:', err)
      }
    },
    isScreenSharing,
    toggleScreenShare: async () => {
      if (isScreenSharing) {
        revertToOptics()
        return
      }

      const local = useCallStore.getState().localStream
      if (!local) return

      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })

        const screenVideoTrack = screenStream.getVideoTracks()[0]
        if (!screenVideoTrack) {
          screenStream.getTracks().forEach(t => t.stop())
          return
        }

        const currentVideoTrack = local.getVideoTracks()[0] ?? null
        originalOpticsRef.current = currentVideoTrack

        pcsRef.current.forEach(pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video')
          if (sender) void sender.replaceTrack(screenVideoTrack)
        })

        if (currentVideoTrack) local.removeTrack(currentVideoTrack)
        local.addTrack(screenVideoTrack)
        screenFeedRef.current = screenVideoTrack
        setLocalStream(local)
        setIsScreenSharing(true)

        screenVideoTrack.onended = () => {
          revertToOptics()
        }

        const screenAudioTrack = screenStream.getAudioTracks()[0]
        if (screenAudioTrack) {
          pcsRef.current.forEach(pc => {
            pc.addTrack(screenAudioTrack, screenStream)
          })
          const origOnEnded = screenVideoTrack.onended
          screenVideoTrack.onended = () => {
            screenAudioTrack.stop()
            if (typeof origOnEnded === 'function') origOnEnded.call(screenVideoTrack, new Event('ended'))
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'NotAllowedError') {
          console.error('[SYS.MEDIA] SCREENSHARE_FAULT:', err)
        }
      }
    },
    setQuality,
  }
}

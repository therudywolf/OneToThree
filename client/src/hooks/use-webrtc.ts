'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { startOutgoingRingtone } from '@/lib/call-ringtones'
import { isAndroidMobile as _isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS as _isIOSOrIPadOS } from '@/lib/ios'
import { useTranslation } from '@/hooks/use-translation'
import {
  getUserMediaConstraints,
  loadMediaPrefs,
  loadCamEffectImage,
  saveMediaPrefs,
  getDisplayMediaOptions,
  applyScreenTrackSettings,
  getScreenShareMaxBitrateBps,
  getScreenShareDegradationPreference,
  type CameraEffectPref,
} from '@/lib/media-devices'
import { upgradeLocalStreamAudio, type VoiceProcessingHandle } from '@/lib/voice-processing'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'
import { mungeOpusStereo } from '@/lib/sdp-munge'
import {
  isMediaPermissionDenied,
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
} from '@/lib/media-limits'
import { useCallStore } from '@/store/callStore'
import { useSessionStore } from '@/store/sessionStore'
import { lookupUsers } from '@/lib/api/users'
import { KDF_CTX, deriveSharedSecret, decryptBytes, encryptBytes, importEcdhPublicKey } from '@/lib/crypto'
import { getIceConfig, normalizeIceServers, type IceTransportPolicy } from '@/lib/ice-servers'
import { notifyIfIceStunOnlyOnce } from '@/lib/ice-relay-warning'
import { AudioRelayPlayer, startAudioRelayCapture, type AudioRelayCaptureController } from '@/lib/call-audio-relay'
import { toastWarn } from '@/store/toastStore'
import { buildCallRejectMessage, upsertIncomingCall } from '@/lib/incoming-call'
import { applyVideoTrack, tuneScreenShareSender } from '@/lib/call-media-tracks'
import { createKeyedGroupChat } from '@/lib/create-group-chat'
import { joinGroupCall } from '@/lib/group-call-manager'

/**
 * PROJECT 13 :: WEBRTC_SIGNAL_PROTOCOL
 * Level: Transmission Layer (Zero-Trust)
 * Vibe: Clinical Steel / Terminal Noir
 */



async function getSignalRelays(): Promise<{
  iceServers: RTCIceServer[]
  transportPolicy: IceTransportPolicy
  hasRelay: boolean
  originSafe: boolean
  p2pAllowed: boolean
  relayFallback?: 'websocket_audio'
}> {
  // ICE/TURN credentials must come from `/api/ice-servers` (Cloudflare short-lived
  // or coturn HMAC); never embed TURN passwords in the client bundle.
  const config = await getIceConfig()
  notifyIfIceStunOnlyOnce()
  return {
    iceServers: normalizeIceServers(config.iceServers),
    transportPolicy: config.transportPolicy,
    hasRelay: config.hasRelay,
    originSafe: config.originSafe,
    p2pAllowed: config.p2pAllowed,
    relayFallback: config.relayFallback,
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
    // OverconstrainedError is almost always a stale `deviceId: { exact }` from a
    // previously-selected mic/camera that is no longer present. Retry with the
    // exact deviceId dropped (→ default device) while PRESERVING the original
    // audio/video flags — never coerce video ON for an audio-only call, and never
    // reuse the failing deviceId (which would just throw again). (issue #1)
    if ((err as Error)?.name === 'OverconstrainedError') {
      const relax = (
        c: boolean | MediaTrackConstraints | undefined
      ): boolean | MediaTrackConstraints | undefined => {
        if (!c || c === true) return c
        const rest: MediaTrackConstraints = { ...c }
        delete rest.deviceId
        return Object.keys(rest).length ? rest : true
      }
      return await navigator.mediaDevices.getUserMedia({
        audio: relax(constraints.audio),
        video: relax(constraints.video),
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
  /** `streamId` (new clients) announces the dedicated msid of the SECOND video
   * m-line carrying the screen, so the receiver routes it into a separate
   * `peer#screen` tile while the camera keeps flowing on the main one. */
  | { kind: 'screen_share'; active: boolean; streamId?: string }
  /** `callNonce` salts the per-call frame key — see relayCallNonceRef. */
  | { kind: 'relay_offer'; callNonce?: string }
  | { kind: 'relay_answer'; callNonce?: string }
  | { kind: 'relay_frame'; ciphertext: string; iv: string; sampleRate: number; seq?: number }
  /** 1:1 → group promotion (#4): the initiator created a keyed group chat and
   *  is moving the call there; the peer tears down the 1:1 and joins the room. */
  | { kind: 'promote_to_group'; chatId: string }

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
  const { t } = useTranslation()
  const [peerReady, setPeerReady] = useState(false)
  const [mediaAccessError, setMediaAccessError] = useState<string | null>(null)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  /** Whether the current share captured an audio track, and its local mute. */
  const [hasScreenAudio, setHasScreenAudio] = useState(false)
  const [isScreenAudioMuted, setIsScreenAudioMuted] = useState(false)
  /** Local preview stream of the OWN screen share (video only) — rendered as
   * its own tile now that the camera keeps its slot during a share. */
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null)
  // Camera lifecycle is tracked independently from screen-share. A call starts
  // audio-only; the camera track is created lazily the first time the user opts
  // into video. `isCameraOn` reflects whether a *camera* track exists AND is
  // enabled — screen-share must never flip this.
  const [isCameraOn, setIsCameraOn] = useState(false)

  const pcsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({})
  // The live camera track (getUserMedia). Distinct from the screen track so the
  // two media sources are never conflated.
  const cameraFeedRef = useRef<MediaStreamTrack | null>(null)
  const screenFeedRef = useRef<MediaStreamTrack | null>(null)
  /** The screen-share AUDIO track (tab/system audio), tracked so the in-app
   * stop can remove it from peers and stop it — not just the video track. */
  const screenAudioFeedRef = useRef<MediaStreamTrack | null>(null)
  /** Dedicated msid stream for OUTGOING screen tracks — its id is announced in
   * the screen_share signal so receivers can split the screen into its own
   * tile while the camera stays on the main m-line. */
  const screenMsidStreamRef = useRef<MediaStream | null>(null)
  /** Per-peer RTP senders carrying the screen (video + optional audio), so
   * camera operations can exclude them and stop can remove exactly them. */
  const screenSendersRef = useRef(new Map<string, { video: RTCRtpSender; audio?: RTCRtpSender }>())
  /** Announced screen msid per REMOTE peer (from their screen_share signal). */
  const remoteScreenStreamIdsRef = useRef(new Map<string, string>())
  const disconnectTimersRef = useRef(new Map<string, number>())
  const ringStopRef = useRef<(() => void) | null>(null)
  const facingModeRef = useRef<'user' | 'environment'>('user')
  /** Live mic-processing chain (noise gate). Disposed on call teardown so the
   * raw hardware track (and its LED) is released with the call. */
  const voiceProcRef = useRef<VoiceProcessingHandle | null>(null)
  /** Live camera-effects chain (background blur/replacement). When active,
   * cameraFeedRef holds the PROCESSED track and this handle owns the raw one. */
  const camFxRef = useRef<CameraEffectsHandle | null>(null)

  const statsIntervalRef = useRef<number | null>(null)

  const iceRetryTimersRef = useRef(new Map<string, number>())
  const connectTimeoutRef = useRef<number | null>(null)
  const pendingInitialOfferRef = useRef(new Set<string>())
  const relayPlayersRef = useRef(new Map<string, AudioRelayPlayer>())
  const relayCapturesRef = useRef(new Map<string, AudioRelayCaptureController>())
  const relayKeysRef = useRef(new Map<string, Promise<CryptoKey | null>>())
  const relayPeersRef = useRef(new Set<string>())
  /**
   * Per-call salt for the relay frame key.
   *
   * The frame key used to be the raw static ECDH secret of the two identities,
   * so EVERY call between the same pair reused one key forever: frames captured
   * from one call decrypt in the next, and there is no forward secrecy across
   * calls at all. The caller mints a nonce with relay_offer, the callee echoes
   * it in relay_answer, and both fold it into the HKDF info label — a fresh key
   * per call for free, with no new primitive.
   */
  const relayCallNonceRef = useRef(new Map<string, string>())
  /** Outbound frame counter per peer, and the highest inbound seq accepted. */
  const relaySeqOutRef = useRef(new Map<string, number>())
  const relaySeqInRef = useRef(new Map<string, number>())
  /** Last 1:1 call peer + grace deadline — lets a `promote_to_group` that lost
   *  the race against the peer's call_leave still be honored (#4). */
  const recentCallPeerRef = useRef<{ peerId: string; until: number } | null>(null)
  const relayAwaitingAnswerRef = useRef(new Set<string>())
  const p2pFallbackStartedRef = useRef(new Set<string>())
  // Grab the (stable) store actions via getState() — NOT a selectorless
  // `useCallStore()`, which subscribes this hook (mounted in the ~1600-line
  // ChatApp root) to the ENTIRE call store and re-renders the whole chat tree on
  // every call-store mutation, e.g. the 5s connection-quality poll during a call
  // (#1/#3). Zustand actions never change identity, so this needs no subscription.
  const {
    setIncomingCall, reset: resetCallStore, addPeerConnection,
    removePeerConnection, setRemoteStream, removeRemoteStream,
    setLocalStream, setIsCalling, clearRemotePeerMedia,
    setReconnecting, setConnectionLost, setIceRetryCount,
    setConnectionQuality,
    setPeerConnectionType, clearPeerConnectionType,
    setCallStartTime, setMiniPlayer: _setMiniPlayer,
    setCallChatId, bumpLocalMediaRev,
  } = useCallStore.getState()

  /**
   * Bind each relay frame to its direction and position in the stream.
   *
   * Frames carried no associated data and no counter, so a captured frame could
   * be replayed verbatim — or reordered — and the receiver would decrypt and
   * play it, because AES-GCM only proved "someone with the key made this", not
   * "this is frame N of this call, from them to me".
   */
  const relayFrameAad = useCallback((fromId: string, toId: string, seq: number): Uint8Array => {
    return new TextEncoder().encode(`p13:call-relay:v1|${fromId}|${toId}|${seq}`)
  }, [])

  const resolveRelaySharedKey = useCallback(async (peerId: string): Promise<CryptoKey | null> => {
    const cached = relayKeysRef.current.get(peerId)
    if (cached) return cached
    const task = (async () => {
      const ownPrivateKey = useSessionStore.getState().unwrappedPrivateKey
      if (!ownPrivateKey) return null
      const [peer] = await lookupUsers([peerId])
      if (!peer?.ecdh_public_key_jwk) return null
      const peerPublicKey = await importEcdhPublicKey(peer.ecdh_public_key_jwk)
      // #34: call relay derives under its own domain, separate from the message
      // fan-out / group-wrap key of the same identity ECDH pair. The per-call
      // nonce is folded into the same info label so each call gets a distinct
      // key instead of reusing one static secret for the pair forever.
      const nonce = relayCallNonceRef.current.get(peerId)
      const ctx = nonce ? `${KDF_CTX.CALL}|${nonce}` : KDF_CTX.CALL
      return deriveSharedSecret(ownPrivateKey, peerPublicKey, ctx)
    })().catch(() => null)
    relayKeysRef.current.set(peerId, task)
    return task
  }, [])

  /** Install the call nonce and drop any key cached under the previous one. */
  const setRelayCallNonce = useCallback((peerId: string, nonce: string | undefined) => {
    if (!nonce) return
    if (relayCallNonceRef.current.get(peerId) === nonce) return
    relayCallNonceRef.current.set(peerId, nonce)
    relayKeysRef.current.delete(peerId)
    relaySeqOutRef.current.delete(peerId)
    relaySeqInRef.current.delete(peerId)
  }, [])

  const stopRelayPeer = useCallback((peerId: string) => {
    relayCapturesRef.current.get(peerId)?.stop()
    relayCapturesRef.current.delete(peerId)
    relayPlayersRef.current.get(peerId)?.stop()
    relayPlayersRef.current.delete(peerId)
    relayKeysRef.current.delete(peerId)
    relayPeersRef.current.delete(peerId)
    relayAwaitingAnswerRef.current.delete(peerId)
  }, [])

  const ensureRelayPlayer = useCallback((peerId: string) => {
    const existing = relayPlayersRef.current.get(peerId)
    if (existing) return existing
    const player = new AudioRelayPlayer()
    relayPlayersRef.current.set(peerId, player)
    relayPeersRef.current.add(peerId)
    setRemoteStream(peerId, player.stream)
    setPeerConnectionType(peerId, 'relay')
    return player
  }, [setPeerConnectionType, setRemoteStream])

  const startRelayCapture = useCallback(async (peerId: string, stream: MediaStream) => {
    if (relayCapturesRef.current.has(peerId)) return true
    const sharedKey = await resolveRelaySharedKey(peerId)
    if (!sharedKey) return false
    let busy = false
    const capture = await startAudioRelayCapture(stream, ({ sampleRate, pcm }) => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          const seq = (relaySeqOutRef.current.get(peerId) ?? 0) + 1
          relaySeqOutRef.current.set(peerId, seq)
          const encrypted = await encryptBytes(
            sharedKey,
            pcm,
            relayFrameAad(userId ?? '', peerId, seq)
          )
          transmitSignal(peerId, {
            kind: 'relay_frame',
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            sampleRate,
            seq,
          })
        } finally {
          busy = false
        }
      })()
    })
    relayCapturesRef.current.set(peerId, capture)
    relayPeersRef.current.add(peerId)
    setPeerConnectionType(peerId, 'relay')
    return true
  }, [relayFrameAad, resolveRelaySharedKey, setPeerConnectionType, userId])

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
    // Remember who we were just in a call with: the peer's `promote_to_group`
    // signal can arrive AFTER their call_leave already tore this link down
    // (broadcast vs targeted relay have no ordering), and the promote guard
    // must still recognize them for a short grace window (#4).
    recentCallPeerRef.current = { peerId, until: Date.now() + 30_000 }
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
    removeRemoteStream(`${peerId}#screen`)
    remoteScreenStreamIdsRef.current.delete(peerId)
    screenSendersRef.current.delete(peerId)
    clearRemotePeerMedia(peerId)
    clearPeerConnectionType(peerId)
    stopRelayPeer(peerId)
    p2pFallbackStartedRef.current.delete(peerId)
    delete pendingIceRef.current[peerId]
  }, [removePeerConnection, removeRemoteStream, clearRemotePeerMedia, clearPeerConnectionType, stopRelayPeer])

  /**
   * Swap the raw mic track of a freshly captured stream for the processed one
   * (noise gate chain). Best-effort: on failure the raw track stays and the
   * call proceeds unprocessed.
   */
  const attachVoiceChain = useCallback(async (stream: MediaStream) => {
    voiceProcRef.current?.dispose()
    voiceProcRef.current = null
    try {
      voiceProcRef.current = await upgradeLocalStreamAudio(stream)
    } catch {
      voiceProcRef.current = null
    }
  }, [])

  /**
   * Wrap a freshly acquired RAW camera track in the background-effects chain
   * when the pref asks for one. Returns the track to PUBLISH (processed, or
   * the raw one when effects are off/unavailable). Any previous chain is
   * disposed first (its raw hardware track is stopped with it).
   */
  const wrapCameraTrack = useCallback(async (raw: MediaStreamTrack): Promise<MediaStreamTrack> => {
    camFxRef.current?.dispose()
    camFxRef.current = null
    const prefs = loadMediaPrefs()
    if (prefs.camEffect === 'none') return raw
    try {
      const handle = await createEffectedCameraTrack(raw, {
        kind: prefs.camEffect,
        imageDataUrl: loadCamEffectImage(),
      })
      if (!handle) return raw
      camFxRef.current = handle
      return handle.processedTrack
    } catch {
      return raw
    }
  }, [])

  /** Stop the published camera track AND its effects chain (raw included). */
  const stopCameraTrack = useCallback((published: MediaStreamTrack | null) => {
    if (camFxRef.current) {
      camFxRef.current.dispose()
      camFxRef.current = null
    }
    published?.stop()
  }, [])

  /**
   * Stop screen-share. The screen lives on its OWN senders now (camera + screen
   * are published simultaneously), so stopping is just removing those senders
   * and stopping the capture — the camera is never touched.
   */
  const revertToOptics = useCallback(() => {
    const screen = screenFeedRef.current
    if (screen) screen.onended = null

    pcsRef.current.forEach((pc, id) => {
      const senders = screenSendersRef.current.get(id)
      if (!senders) return
      try { pc.removeTrack(senders.video) } catch { /* closed */ }
      if (senders.audio) {
        try { pc.removeTrack(senders.audio) } catch { /* closed */ }
      }
    })
    screenSendersRef.current.clear()

    screen?.stop()
    screenAudioFeedRef.current?.stop()
    screenAudioFeedRef.current = null
    screenFeedRef.current = null
    screenMsidStreamRef.current = null
    setLocalScreenStream(null)
    setIsScreenSharing(false)
    setHasScreenAudio(false)
    setIsScreenAudioMuted(false)
    bumpLocalMediaRev()
    pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'screen_share', active: false }))
    relayPeersRef.current.forEach((id) => transmitSignal(id, { kind: 'screen_share', active: false }))
  }, [bumpLocalMediaRev])

  const severAllLinks = useCallback(() => {
    ringStopRef.current?.()
    if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    setMediaAccessError(null)
    revertToOptics()
    
    // Leave the CALL's chat, not whatever chat happens to be open — the user
    // may have navigated to a different chat mid-call. Fall back to activeChatId.
    const chatId = useCallStore.getState().callChatId ?? useSessionStore.getState().activeChatId
    if (chatId) getFmSocket().send({ type: 'call_leave', chat_id: chatId })

    Array.from(pcsRef.current.keys()).forEach(purgePeer)
    Array.from(relayPeersRef.current).forEach(purgePeer)
    p2pFallbackStartedRef.current.clear()

    // Tear down the camera track and reset opt-in media state for the next
    // call. The effects chain (if any) is disposed too — it owns the RAW
    // hardware track whose LED would otherwise stay lit.
    camFxRef.current?.dispose()
    camFxRef.current = null
    cameraFeedRef.current?.stop()
    cameraFeedRef.current = null
    facingModeRef.current = 'user'
    setIsCameraOn(false)

    // Release the mic-processing chain — stops the RAW hardware track too
    // (terminateFeed below only reaches the processed track in localStream).
    voiceProcRef.current?.dispose()
    voiceProcRef.current = null

    const state = useCallStore.getState()
    terminateFeed(state.localStream)
    resetCallStore()
  }, [purgePeer, resetCallStore, revertToOptics])

  /**
   * Reconcile the peer's remote MediaStream with the pc's live RECEIVERS.
   * Renegotiation that reuses a transceiver (camera re-on after a hard-off,
   * screen share from a camera-less peer) does not reliably re-fire ontrack,
   * and a replaceTrack'd sender ships no msid — the receiver set after an SDP
   * exchange is the only truth. Publishes a NEW stream identity when a track
   * was missing so tiles re-run their effects.
   */
  const syncRemoteFromReceivers = useCallback((peerId: string, pc: RTCPeerConnection) => {
    const receiving: MediaStreamTrack[] = []
    for (const tr of pc.getTransceivers()) {
      const dir = tr.currentDirection
      if (!dir || dir === 'inactive' || dir === 'stopped' || dir === 'sendonly') continue
      const track = tr.receiver?.track
      if (track && track.readyState === 'live') receiving.push(track)
    }
    if (receiving.length === 0) return
    const state = useCallStore.getState()
    // Tracks already routed into the peer's SCREEN entry must not be merged
    // into the main stream too.
    const screenEntry = state.remoteStreams[`${peerId}#screen`]
    const screenTracks = new Set(screenEntry ? screenEntry.getTracks() : [])
    const wanted = receiving.filter((t_) => !screenTracks.has(t_))
    if (wanted.length === 0) return
    const current = state.remoteStreams[peerId]
    const curTracks = current ? current.getTracks() : []
    const missing = wanted.filter((t_) => !curTracks.includes(t_))
    if (missing.length === 0) return
    setRemoteStream(
      peerId,
      new MediaStream([...curTracks.filter((t_) => t_.readyState === 'live'), ...missing])
    )
  }, [setRemoteStream])

  const createAndSendOffer = useCallback(async (
    peerId: string,
    pc: RTCPeerConnection,
    options?: RTCOfferOptions
  ) => {
    if (pc.signalingState !== 'stable') return
    const offer = await pc.createOffer(options)
    // Opus stereo + bitrate ceiling for screen-share audio (see sdp-munge.ts).
    offer.sdp = mungeOpusStereo(offer.sdp ?? '')
    await pc.setLocalDescription(offer)
    transmitSignal(peerId, {
      kind: 'offer',
      sdp: offer.sdp ?? '',
      isVideo: !!useCallStore.getState().localStream?.getVideoTracks().length,
    })
  }, [])

  const setupPeerLink = useCallback((peerId: string, pc: RTCPeerConnection) => {
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return
      if (pendingInitialOfferRef.current.has(peerId)) return
      try {
        await createAndSendOffer(peerId, pc)
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
            await createAndSendOffer(peerId, pc, { iceRestart: true })
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
              await createAndSendOffer(peerId, pc, { iceRestart: true })
            } catch {
              console.warn('[SYS.ICE] ICE restart retry failed for', peerId.slice(0, 8))
            }
          }, 5000)
          iceRetryTimersRef.current.set(peerId, retryTimer)
        } else {
          // 3 retries exhausted -> connection lost
          console.error('[SYS.ICE] All retries exhausted for', peerId.slice(0, 8))
          setReconnecting(false)
          setConnectionLost(true)
        }
      } else if (iceState === 'closed') {
        purgePeer(peerId)
      }
    }

    pc.ontrack = (ev) => {
      const evStream = ev.streams[0]
      // The peer's announced screen msid routes into a SEPARATE tile entry —
      // camera and screen flow simultaneously on their own m-lines.
      const screenSid = remoteScreenStreamIdsRef.current.get(peerId)
      if (evStream && screenSid && evStream.id === screenSid) {
        setRemoteStream(`${peerId}#screen`, evStream)
        return
      }
      if (evStream) {
        setRemoteStream(peerId, evStream)
        return
      }
      // No msid: the track arrived via replaceTrack on a reused transceiver
      // (e.g. screen share from a peer that never enabled the camera). Merge it
      // into this peer's stream under a NEW identity so React effects re-run.
      const current = useCallStore.getState().remoteStreams[peerId]
      const tracks = current ? current.getTracks().filter((t_) => t_ !== ev.track) : []
      setRemoteStream(peerId, new MediaStream([...tracks, ev.track]))
    }

    pc.onicecandidate = (ev) => {
      transmitSignal(peerId, {
        kind: 'ice',
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
  }, [createAndSendOffer, setRemoteStream, purgePeer, setReconnecting, setConnectionLost, setIceRetryCount])

  const establishAudioRelay = useCallback(async (peerId: string, chatId: string, requestedVideo: boolean, sendInvite = true) => {
    setCallChatId(chatId)
    let stream: MediaStream
    try {
      stream = await captureLocalFeed(getUserMediaConstraints({ video: false, hd: false }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      return
    }
    await attachVoiceChain(stream)

    const sharedKey = await resolveRelaySharedKey(peerId)
    if (!sharedKey) {
      terminateFeed(stream)
      setMediaAccessError('CALL_RELAY_KEY_UNAVAILABLE')
      setIsCalling(false)
      return
    }

    relayKeysRef.current.set(peerId, Promise.resolve(sharedKey))
    relayPeersRef.current.add(peerId)
    relayAwaitingAnswerRef.current.add(peerId)
    setLocalStream(stream)
    setIsCalling(true)
    setCallStartTime(Date.now())
    setPeerConnectionType(peerId, 'relay')
    // Only send call_invite when this IS the initial invite. When called from
    // fallbackToAudioRelay (P2P/ICE failed), the invite was already sent on the
    // P2P attempt; a second one makes the already-ringing/connected callee
    // auto-reject as busy (see call_invite handler), which kills the whole call.
    if (sendInvite) {
      getFmSocket().send({
        type: 'call_invite',
        chat_id: chatId,
        is_video: false,
      })
    }
    // Mint the per-call salt before any key is derived for this peer.
    const callNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    setRelayCallNonce(peerId, callNonce)
    transmitSignal(peerId, { kind: 'relay_offer', callNonce })
    ringStopRef.current = startOutgoingRingtone()
    if (requestedVideo) {
      toastWarn(t('call.audioRelayFallback'), { title: t('call.iceRelayTitle') })
    }
    connectTimeoutRef.current = window.setTimeout(() => {
      const hasRemote = Boolean(useCallStore.getState().remoteStreams[peerId])
      if (!hasRemote && useCallStore.getState().isCalling) {
        console.warn('[SYS.RELAY] 30s connection timeout — no relay audio frames')
        severAllLinks()
      }
    }, 30_000)
  }, [attachVoiceChain, resolveRelaySharedKey, setCallStartTime, setIsCalling, setLocalStream, setPeerConnectionType, severAllLinks, t])

  const fallbackToAudioRelay = useCallback(async (peerId: string, chatId: string, requestedVideo: boolean) => {
    if (relayPeersRef.current.has(peerId) || relayAwaitingAnswerRef.current.has(peerId)) return
    if (p2pFallbackStartedRef.current.has(peerId)) return
    p2pFallbackStartedRef.current.add(peerId)
    ringStopRef.current?.()

    const pc = pcsRef.current.get(peerId)
    if (pc) {
      try { pc.close() } catch { /* noop */ }
      pcsRef.current.delete(peerId)
    }
    removePeerConnection(peerId)
    removeRemoteStream(peerId)
    clearRemotePeerMedia(peerId)
    clearPeerConnectionType(peerId)
    delete pendingIceRef.current[peerId]

    const local = useCallStore.getState().localStream
    terminateFeed(local)
    // Fallback path: the call_invite was already sent on the P2P attempt — do
    // NOT re-send it (would trigger the callee's busy auto-reject).
    await establishAudioRelay(peerId, chatId, requestedVideo, false)
  }, [clearPeerConnectionType, clearRemotePeerMedia, establishAudioRelay, removePeerConnection, removeRemoteStream])

  const acceptAudioRelay = useCallback(async (peerId: string) => {
    const incChatId = useCallStore.getState().incomingCall?.chatId
    if (incChatId) setCallChatId(incChatId)
    let stream: MediaStream
    try {
      stream = await captureLocalFeed(getUserMediaConstraints({ video: false, hd: false }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      setIncomingCall(null)
      return
    }
    await attachVoiceChain(stream)

    const sharedKey = await resolveRelaySharedKey(peerId)
    if (!sharedKey) {
      terminateFeed(stream)
      setMediaAccessError('CALL_RELAY_KEY_UNAVAILABLE')
      setIncomingCall(null)
      return
    }

    relayKeysRef.current.set(peerId, Promise.resolve(sharedKey))
    relayPeersRef.current.add(peerId)
    setLocalStream(stream)
    setIsCalling(true)
    setCallStartTime(Date.now())
    setPeerConnectionType(peerId, 'relay')
    const started = await startRelayCapture(peerId, stream)
    if (!started) {
      terminateFeed(stream)
      setMediaAccessError('CALL_RELAY_KEY_UNAVAILABLE')
      setIncomingCall(null)
      return
    }
    transmitSignal(peerId, {
      kind: 'relay_answer',
      callNonce: relayCallNonceRef.current.get(peerId),
    })
    setIncomingCall(null)
  }, [attachVoiceChain, resolveRelaySharedKey, setCallStartTime, setIncomingCall, setIsCalling, setLocalStream, setPeerConnectionType, startRelayCapture])

  const rejectLink = useCallback(() => {
    const reject = buildCallRejectMessage(useCallStore.getState().incomingCall)
    if (reject) getFmSocket().send(reject)
    setIncomingCall(null)
  }, [setIncomingCall])

  /**
   * 1:1 → group promotion (#4): create a keyed group chat with the current call
   * peer + the invitee, tell the peer to migrate (opaque `promote_to_group`
   * signal over the existing WS relay — no server changes), tear down the 1:1
   * and join the group room. The invitee is notified via the standard
   * group-call machinery: `chats_updated` (new chat), `group_call:active`
   * banner, and the offline push on first join.
   */
  const promoteToGroup = useCallback(async (inviteeUserId: string) => {
    const privKey = useSessionStore.getState().unwrappedPrivateKey
    if (!userId || !privKey) throw new Error('NO_VAULT')
    const peers = new Set<string>([
      ...pcsRef.current.keys(),
      ...relayPeersRef.current,
    ])
    peers.delete(userId)
    const peerId = Array.from(peers)[0]
    if (!peerId) throw new Error('NO_ACTIVE_PEER')
    if (inviteeUserId === peerId || inviteeUserId === userId) {
      throw new Error('ALREADY_IN_CALL')
    }

    // 1. Group chat with all three, fully keyed (server broadcasts chats_updated).
    const chat = await createKeyedGroupChat(userId, privKey, null, [peerId, inviteeUserId])
    // 2. Tell the peer BEFORE tearing down, so the signal wins any teardown race.
    transmitSignal(peerId, { kind: 'promote_to_group', chatId: chat.id })
    // 3. End our side of the 1:1 (sends call_leave; harmless in either order).
    severAllLinks()
    // 4. Join the group room — our join broadcasts group_call:active to the
    //    invitee (banner) and fires the offline push if they're disconnected.
    const ok = await joinGroupCall(chat.id, false)
    if (ok) useSessionStore.getState().setActiveChatId(chat.id)
  }, [userId, severAllLinks])

  // Socket Subscription Layer
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    
    return socket.subscribe(async (msg) => {
      if (msg.type === 'call_invite') {
        const state = useCallStore.getState()
        const fromId = msg.from_user_id
        // DND — auto-reject without showing the modal.
        if (state.dndEnabled) {
          getFmSocket().send({ type: 'call_reject', chat_id: msg.chat_id })
          return
        }
        // The caller sends `call_invite` and the SDP `offer` as two independent WS
        // messages relayed on separate paths, so the offer can arrive FIRST and
        // pre-create an incomingCall for THIS peer (with no chatId yet — see the
        // `offer` handler below). Do NOT treat that as "busy" and reject our own
        // call; only reject when actually in a call or ringing for a DIFFERENT
        // peer. Otherwise MERGE the invite (chatId/isVideo) into the existing
        // record so accept can send call_accept (issue #1: first-call failures).
        const ringingForSamePeer =
          !!state.incomingCall && state.incomingCall.peerId === fromId
        if (state.isCalling || (state.incomingCall && !ringingForSamePeer)) {
          // Busy, or already showing another incoming invite: send call_reject
          // so the caller gets an immediate decline instead of ringing out for
          // 30s with no busy signal. Mirrors the DND auto-reject above.
          getFmSocket().send({ type: 'call_reject', chat_id: msg.chat_id })
          return
        }
        const peerId = fromId
        // upsert (not overwrite): preserves any offer/transport already stamped by
        // an early offer that won the race.
        setIncomingCall(upsertIncomingCall(state.incomingCall, {
          peerId,
          chatId: msg.chat_id,
          isVideo: msg.is_video,
        }))
        void lookupUsers([peerId]).then(([u]) => {
          const current = useCallStore.getState().incomingCall
          if (u && current?.peerId === peerId) {
            setIncomingCall(upsertIncomingCall(current, {
              peerId,
              peerUsername: u.username,
            }))
          }
        }).catch(() => { /* best-effort */ })
      }

      if (msg.type === 'call_leave') {
        purgePeer(msg.from_user_id)
        // If no peers remain, end the call entirely
        if (pcsRef.current.size === 0 && useCallStore.getState().isCalling) {
          severAllLinks()
        }
      }

      if (msg.type === 'call_reject') {
        // Remote peer explicitly declined — clean up and notify the caller
        purgePeer(msg.from_user_id)
        if (useCallStore.getState().isCalling) {
          severAllLinks()
        }
        toastWarn(t('call.rejected'), { title: t('call.rejectedTitle') })
      }

      if (msg.type === 'call_cancel_on_other_devices') {
        // Another device of ours accepted this call — dismiss modal on this device
        const inc = useCallStore.getState().incomingCall
        if (inc?.chatId === msg.chat_id) {
          setIncomingCall(null)
        }
      }

      if (msg.type === 'webrtc_signal') {
        const { fromUserId, signalData: rawSignal } = msg
        const data = rawSignal as {
          kind: string
          media?: string
          enabled?: boolean
          active?: boolean
          sdp?: string
          isVideo?: boolean
          candidate?: RTCIceCandidateInit
          ciphertext?: string
          iv?: string
          sampleRate?: number
          chatId?: string
          /** Per-call key salt (relay_offer / relay_answer). */
          callNonce?: string
          /** Monotonic frame counter, bound into the AAD (relay_frame). */
          seq?: number
          /** Dedicated screen msid (screen_share) — dual camera+screen. */
          streamId?: string
        }
        if (fromUserId === userId) return

        if (data.kind === 'promote_to_group') {
          // 1:1 → group promotion (#4). Only honor it when it comes from the peer
          // we are ACTUALLY in a call with (mesh, relay, or ringing) — the server
          // relay already authorizes shared-chat + non-blocked, but a random
          // contact must not be able to yank us into a room.
          const recent = recentCallPeerRef.current
          const inCallWith =
            pcsRef.current.has(fromUserId) ||
            relayPeersRef.current.has(fromUserId) ||
            useCallStore.getState().incomingCall?.peerId === fromUserId ||
            (recent?.peerId === fromUserId && Date.now() < recent.until)
          if (!inCallWith || typeof data.chatId !== 'string' || !data.chatId) return
          const targetRoomId = data.chatId
          severAllLinks()
          void joinGroupCall(targetRoomId, false).then((ok) => {
            if (ok) useSessionStore.getState().setActiveChatId(targetRoomId)
          })
          return
        }

        if (data.kind === 'media_state') {
          const update = data.media === 'audio' ? { micMuted: !data.enabled } : { cameraOff: !data.enabled }
          useCallStore.getState().setRemotePeerMedia(fromUserId, update)
          return
        }

        if (data.kind === 'screen_share') {
          useCallStore.getState().setRemotePeerMedia(fromUserId, { screenSharing: data.active })
          if (data.active && typeof data.streamId === 'string' && data.streamId) {
            // New clients announce the dedicated screen msid BEFORE adding the
            // tracks — register it so ontrack routes them into `peer#screen`.
            remoteScreenStreamIdsRef.current.set(fromUserId, data.streamId)
          } else if (!data.active) {
            remoteScreenStreamIdsRef.current.delete(fromUserId)
            removeRemoteStream(`${fromUserId}#screen`)
          }
          return
        }

        if (data.kind === 'relay_offer') {
          // Adopt the caller's per-call salt before any key is derived for them.
          setRelayCallNonce(fromUserId, data.callNonce)
          if (useCallStore.getState().isCalling) {
            const pc = pcsRef.current.get(fromUserId)
            if (pc) {
              try { pc.close() } catch { /* noop */ }
              pcsRef.current.delete(fromUserId)
              removePeerConnection(fromUserId)
            }
            removeRemoteStream(fromUserId)
            clearRemotePeerMedia(fromUserId)
            clearPeerConnectionType(fromUserId)
            delete pendingIceRef.current[fromUserId]

            const localStream = useCallStore.getState().localStream
            if (localStream) {
              const started = await startRelayCapture(fromUserId, localStream)
              if (started) {
                transmitSignal(fromUserId, {
                  kind: 'relay_answer',
                  callNonce: relayCallNonceRef.current.get(fromUserId),
                })
                ensureRelayPlayer(fromUserId)
              } else {
                setMediaAccessError('CALL_RELAY_KEY_UNAVAILABLE')
              }
            }
            return
          }

          const current = useCallStore.getState().incomingCall
          setIncomingCall(upsertIncomingCall(current, {
            peerId: fromUserId,
            isVideo: false,
            offer: null,
            transport: 'audio_relay',
          }))
          void lookupUsers([fromUserId]).then(([u]) => {
            const active = useCallStore.getState().incomingCall
            if (u && active?.peerId === fromUserId) {
              setIncomingCall(upsertIncomingCall(active, {
                peerId: fromUserId,
                isVideo: false,
                offer: null,
                transport: 'audio_relay',
                peerUsername: u.username,
              }))
            }
          }).catch(() => { /* best-effort */ })
          return
        }

        if (data.kind === 'relay_answer') {
          // The callee echoes the salt; adopting it keeps both sides on the
          // same per-call key even if our own offer raced a reconnect.
          setRelayCallNonce(fromUserId, data.callNonce)
          relayAwaitingAnswerRef.current.delete(fromUserId)
          ringStopRef.current?.()
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current)
            connectTimeoutRef.current = null
          }
          const localStream = useCallStore.getState().localStream
          if (localStream) {
            const started = await startRelayCapture(fromUserId, localStream)
            if (!started) {
              setMediaAccessError('CALL_RELAY_KEY_UNAVAILABLE')
            }
          }
          return
        }

        if (data.kind === 'relay_frame' && data.ciphertext && data.iv && typeof data.sampleRate === 'number') {
          // Only a peer we are ACTUALLY in a relay call with may push audio at
          // us. The server relay authorizes shared-chat + non-blocked and
          // nothing more, so without this gate any contact could send
          // relay_frame with no relay_offer at all: ensureRelayPlayer would
          // register a remote stream, CallAudioSink autoplays every remote
          // stream, and their live microphone would come out of our speakers
          // with no ring, no modal and no hang-up. It also let one stray frame
          // kill the caller's ringtone + no-answer timeout mid-dial.
          //
          // `relayPeersRef` holds exactly the right set: the CALLER adds the
          // peer when it starts the relay call, the CALLEE only on accept — so
          // frames arriving before the human accepts are correctly dropped.
          // Mirrors the group path's `roomId` gate in group-call-manager.ts.
          if (!relayPeersRef.current.has(fromUserId)) return
          // Strictly increasing sequence. Without it a captured frame replays
          // verbatim (the key is the same for the whole call) and out-of-order
          // frames play as if fresh — audio an attacker can rewind and repeat.
          const seq = typeof data.seq === 'number' ? data.seq : null
          if (seq === null) return
          const lastSeq = relaySeqInRef.current.get(fromUserId) ?? 0
          if (seq <= lastSeq) return
          try {
            const sharedKey = await resolveRelaySharedKey(fromUserId)
            if (!sharedKey) return
            // AAD must match the sender's exactly: direction + position. A frame
            // lifted from the other direction, or from another position in the
            // stream, fails the tag rather than decrypting.
            const pcm = await decryptBytes(
              sharedKey,
              data.ciphertext,
              data.iv,
              relayFrameAad(fromUserId, userId ?? '', seq)
            )
            relaySeqInRef.current.set(fromUserId, seq)
            const player = ensureRelayPlayer(fromUserId)
            await player.pushFrame(pcm, data.sampleRate)
          } catch {
            // A malformed/undecryptable frame must not reject the socket
            // callback (unhandled rejection) — drop it like the group path.
            return
          }
          ringStopRef.current?.()
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current)
            connectTimeoutRef.current = null
          }
          setReconnecting(false)
          setConnectionLost(false)
          setIceRetryCount(0)
          return
        }

        const pc = pcsRef.current.get(fromUserId)
        if (data.kind === 'ice' && data.candidate) {
          // Always buffer when there's no usable pc/remoteDescription yet. For
          // the CALLEE no pc exists until acceptLink, so candidates trickled
          // during the human-decision window must be queued (flushIceQueue
          // replays them on accept) — dropping them can fail a relay-only call
          // whose only path was an early TURN candidate.
          if (pc?.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
          else (pendingIceRef.current[fromUserId] ??= []).push(data.candidate)
        }

        if (data.kind === 'offer') {
          if (pc) {
            // Perfect negotiation for offer glare (both peers send an offer at
            // once, e.g. both enable camera within ~1 RTT). The IMPOLITE peer
            // ignores the colliding offer (its own wins); the POLITE peer rolls
            // its local offer back, then accepts. Previously the bare
            // setRemoteDescription threw on collision — an unhandled rejection,
            // and the renegotiated track never appeared.
            const polite = !!userId && userId < fromUserId
            const offerCollision = pc.signalingState !== 'stable'
            if (offerCollision && !polite) return
            try {
              if (offerCollision) await pc.setLocalDescription({ type: 'rollback' })
              await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
              await flushIceQueue(fromUserId, pc)
              const answer = await pc.createAnswer()
              answer.sdp = mungeOpusStereo(answer.sdp ?? '')
              await pc.setLocalDescription(answer)
              transmitSignal(fromUserId, { kind: 'answer', sdp: answer.sdp ?? '' })
              syncRemoteFromReceivers(fromUserId, pc)
            } catch (err) {
              if (typeof console !== 'undefined') {
                console.warn('[webrtc] renegotiation offer handling failed', err)
              }
            }
          } else {
            const callState = useCallStore.getState()
            const current = callState.incomingCall
            // Busy guard, mirroring the `call_invite` handler. The caller sends
            // call_invite and the SDP offer as two independent messages: when we
            // are already in a call the invite is auto-rejected, but the offer
            // still lands here with no pc and used to stamp a phantom
            // incomingCall — an IncomingCallModal (z-250) ringing OVER the live
            // call for a call the other side already tore down. Accepting it ran
            // a second getUserMedia and overwrote localStream, breaking the call
            // actually in progress. Drop it; no call_reject, the offer carries no
            // chatId and the invite handler already declined.
            if (callState.isCalling || (current && current.peerId !== fromUserId)) return
            setIncomingCall(upsertIncomingCall(current, {
              peerId: fromUserId,
              isVideo: !!data.isVideo,
              offer: { type: 'offer', sdp: data.sdp ?? '' },
              transport: 'webrtc',
            }))
            void lookupUsers([fromUserId]).then(([u]) => {
              if (u) {
                const cur = useCallStore.getState().incomingCall
                if (cur?.peerId === fromUserId) {
                  setIncomingCall(upsertIncomingCall(cur, {
                    peerId: fromUserId,
                    peerUsername: u.username,
                  }))
                }
              }
            }).catch(() => { /* best-effort */ })
          }
        }

        if (data.kind === 'answer' && pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
          await flushIceQueue(fromUserId, pc)
          syncRemoteFromReceivers(fromUserId, pc)
        }
      }
    })
  }, [
    userId,
    setIncomingCall,
    purgePeer,
    flushIceQueue,
    severAllLinks,
    resolveRelaySharedKey,
    ensureRelayPlayer,
    startRelayCapture,
    setReconnecting,
    setConnectionLost,
    setIceRetryCount,
    removePeerConnection,
    removeRemoteStream,
    clearRemotePeerMedia,
    clearPeerConnectionType,
    setMediaAccessError,
    syncRemoteFromReceivers,
  ])

  const applyQualityConstraints = useCallback((level: '720p' | '480p' | '360p' | 'audio_only') => {
    const local = useCallStore.getState().localStream
    if (!local) return

    if (level === 'audio_only') {
      local.getVideoTracks().forEach(t => { t.enabled = false })
      useCallStore.getState().bumpLocalMediaRev()
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
    // Give the CAMERA sender an encoder budget matching the level — the track
    // constraints alone don't move the default bitrate cap.
    const cam = cameraFeedRef.current
    if (cam) {
      const bps = level === '720p' ? 2_500_000 : level === '480p' ? 1_000_000 : 600_000
      pcsRef.current.forEach((pc) => {
        void tuneScreenShareSender(pc, cam, bps, 'balanced')
      })
    }
    useCallStore.getState().bumpLocalMediaRev()
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
            void createAndSendOffer(peerId, pc, { iceRestart: true })
          } catch {
            console.warn('[SYS.ICE] Visibility-triggered restart failed for', peerId.slice(0, 8))
          }
        }
      })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [createAndSendOffer])

  // Clean up call on page unload / tab close. A same-tab reload additionally
  // leaves a short-lived marker in sessionStorage so ChatApp can auto-redial
  // (the peer gets a clean call_leave + a fresh ring — no zombie pc state).
  useEffect(() => {
    const handleUnload = () => {
      const state = useCallStore.getState()
      if (!state.isCalling) return
      const chatId = state.callChatId
      severAllLinks()
      if (chatId) {
        try {
          sessionStorage.setItem(
            'p13_active_call',
            JSON.stringify({ chatId, ts: Date.now() })
          )
        } catch { /* storage unavailable */ }
      }
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
    if (chatId) setCallChatId(chatId)
    if (!navigator.onLine) {
      toastWarn(t('call.noNetwork'), { title: t('call.iceRelayTitle') })
      return
    }

    const peerIds = recipients.filter((id) => id !== userId && !pcsRef.current.has(id))
    if (peerIds.length === 0) {
      severAllLinks()
      return
    }

    let signalConfig: Awaited<ReturnType<typeof getSignalRelays>>
    try {
      signalConfig = await getSignalRelays()
    } catch (err) {
      if (peerIds.length === 1 && chatId) {
        await establishAudioRelay(peerIds[0]!, chatId, isVideo)
        return
      }
      setMediaAccessError(err instanceof Error ? err.message : 'ICE_SERVERS_UNAVAILABLE')
      setIsCalling(false)
      return
    }

    if (recipients.length === 1 && chatId && !signalConfig.hasRelay && !signalConfig.p2pAllowed) {
      const peerId = peerIds[0]
      if (peerId) {
        await establishAudioRelay(peerId, chatId, isVideo)
        return
      }
    }

    let stream: MediaStream
    try {
      const prefs = loadMediaPrefs()
      stream = await captureLocalFeed(getUserMediaConstraints({ video: isVideo, hd: !prefs.lowBandwidth }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      return
    }
    await attachVoiceChain(stream)
    // A video call starts with the camera live — register it as the camera
    // track so the in-call toggle can hard-stop it. Background effects wrap
    // the raw track before anything is published.
    const rawCam = stream.getVideoTracks()[0] ?? null
    if (rawCam) {
      const published = await wrapCameraTrack(rawCam)
      if (published !== rawCam) {
        stream.removeTrack(rawCam)
        stream.addTrack(published)
      }
      cameraFeedRef.current = published
    } else {
      cameraFeedRef.current = null
    }
    setIsCameraOn(!!cameraFeedRef.current)
    setLocalStream(stream)
    setIsCalling(true)
    setCallStartTime(Date.now())

    if (chatId) {
      getFmSocket().send({
        type: 'call_invite',
        chat_id: chatId,
        is_video: isVideo,
      })
    }

    const offerTasks: Promise<void>[] = []
    for (const peerId of peerIds) {
      
      const pc = new RTCPeerConnection({
        iceServers: signalConfig.iceServers,
        iceTransportPolicy: signalConfig.transportPolicy,
      })
      pendingInitialOfferRef.current.add(peerId)
      pcsRef.current.set(peerId, pc)
      addPeerConnection(peerId, pc)
      setupPeerLink(peerId, pc)
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
      offerTasks.push(
        createAndSendOffer(peerId, pc)
          .catch((err) => {
            console.error('[SYS.SIGNAL] Initial offer failure:', err)
          })
          .finally(() => {
            pendingInitialOfferRef.current.delete(peerId)
          })
      )
    }

    await Promise.allSettled(offerTasks)

    if (pcsRef.current.size > 0) {
      ringStopRef.current = startOutgoingRingtone()
      // 30s timeout: if no peer reaches 'connected', hang up
      connectTimeoutRef.current = window.setTimeout(() => {
        const anyConnected = Array.from(pcsRef.current.values()).some(
          p => p.iceConnectionState === 'connected' || p.iceConnectionState === 'completed'
        )
        if (!anyConnected && useCallStore.getState().isCalling) {
          console.warn('[SYS.ICE] 30s connection timeout — no peers connected')
          const fallbackPeerId = peerIds.length === 1 ? peerIds[0] : null
          if (fallbackPeerId && chatId && !signalConfig.hasRelay && signalConfig.relayFallback === 'websocket_audio') {
            void fallbackToAudioRelay(fallbackPeerId, chatId, isVideo)
          } else {
            severAllLinks()
          }
        }
      }, 30_000)
    } else {
      severAllLinks()
    }
  }, [userId, setLocalStream, setIsCalling, addPeerConnection, setupPeerLink, severAllLinks, setCallStartTime, establishAudioRelay, createAndSendOffer, fallbackToAudioRelay, attachVoiceChain, wrapCameraTrack])

  const acceptLink = useCallback(async () => {
    const inc = useCallStore.getState().incomingCall
    if (!inc) return

    if (inc.chatId) setCallChatId(inc.chatId)
    // C-4: notify server so other devices of this user dismiss the incoming-call modal
    if (inc.chatId) getFmSocket().send({ type: 'call_accept', chat_id: inc.chatId })

    if (inc.transport === 'audio_relay') {
      await acceptAudioRelay(inc.peerId)
      return
    }

    let signalConfig: Awaited<ReturnType<typeof getSignalRelays>>
    try {
      signalConfig = await getSignalRelays()
    } catch (err) {
      setMediaAccessError(err instanceof Error ? err.message : 'ICE_SERVERS_UNAVAILABLE')
      setIncomingCall(null)
      return
    }

    let stream: MediaStream
    try {
      const prefs = loadMediaPrefs()
      stream = await captureLocalFeed(getUserMediaConstraints({ video: !!inc.isVideo, hd: !prefs.lowBandwidth }))
    } catch (err) {
      setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
      setIncomingCall(null)
      return
    }
    await attachVoiceChain(stream)
    // Register the initial camera track (video answer) — previously it was
    // never stored, so the first in-call camera toggle acquired a SECOND
    // camera while the original kept streaming (and its LED kept burning).
    // Background effects wrap the raw track before anything is published.
    const rawCam = stream.getVideoTracks()[0] ?? null
    if (rawCam) {
      const published = await wrapCameraTrack(rawCam)
      if (published !== rawCam) {
        stream.removeTrack(rawCam)
        stream.addTrack(published)
      }
      cameraFeedRef.current = published
    } else {
      cameraFeedRef.current = null
    }
    setIsCameraOn(!!cameraFeedRef.current)
    setLocalStream(stream)
    const pc = new RTCPeerConnection({
      iceServers: signalConfig.iceServers,
      iceTransportPolicy: signalConfig.transportPolicy,
    })

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
        answer.sdp = mungeOpusStereo(answer.sdp ?? '')
        await pc.setLocalDescription(answer)
        transmitSignal(inc.peerId, { kind: 'answer', sdp: answer.sdp ?? '' })
        syncRemoteFromReceivers(inc.peerId, pc)
      }
    } catch (err) {
      // The SDP could not be applied (codec/bundle mismatch, truncated offer).
      // Just closing the pc left isCalling=true and a dead localStream in the
      // store, so ActiveCallOverlay kept rendering a full-screen call with a
      // frozen tile and a running timer while no answer was ever sent — the
      // user had to hang up a call that never existed. Tear the whole thing
      // down and tell them why (severAllLinks clears mediaAccessError, so the
      // message has to be set after it).
      console.error('[SYS.SIGNAL] Answer negotiation failed:', err)
      severAllLinks()
      setMediaAccessError('CALL_SETUP_FAILED')
    } finally {
      setIncomingCall(null)
    }
  }, [acceptAudioRelay, setLocalStream, addPeerConnection, setupPeerLink, flushIceQueue, severAllLinks, setIncomingCall, setIsCalling, attachVoiceChain, syncRemoteFromReceivers, wrapCameraTrack])

  const toggleMute = useCallback(() => {
    const local = useCallStore.getState().localStream
    if (!local) return
    local.getAudioTracks().forEach(t => (t.enabled = !t.enabled))
    const enabled = local.getAudioTracks()[0]?.enabled ?? true
    pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'media_state', media: 'audio', enabled }))
    relayPeersRef.current.forEach((id) => transmitSignal(id, { kind: 'media_state', media: 'audio', enabled }))
  }, [])

  /**
   * True when this 1:1 call runs over the WebSocket PCM relay instead of
   * WebRTC (origin-safe deployment, or the 30s P2P timeout fell back to
   * `websocket_audio`). The relay carries mono audio and nothing else, so every
   * video path has to be a no-op: previously the camera/screen-share buttons
   * lit up the camera LED, opened the OS screen picker and told the peer
   * "video enabled" / "screen sharing" while not one frame was ever sent.
   */
  const isRelayOnlyCall = useCallback(
    () => pcsRef.current.size === 0 && relayPeersRef.current.size > 0,
    []
  )

  const broadcastVideoState = useCallback((enabled: boolean) => {
    pcsRef.current.forEach((_, id) => transmitSignal(id, { kind: 'media_state', media: 'video', enabled }))
    relayPeersRef.current.forEach((id) => transmitSignal(id, { kind: 'media_state', media: 'video', enabled }))
  }, [])

  /**
   * Toggle the camera. The first time the user opts into video this lazily
   * acquires the camera via getUserMedia (a call starts audio-only). Turning it
   * OFF is a HARD off: the hardware track is stopped (LED goes out), the sender
   * track is cleared, and the next ON re-acquires the device. While screen-share
   * is active the camera track is kept detached from peers — the screen owns
   * the video sender.
   */
  const toggleCamera = useCallback(async () => {
    if (isRelayOnlyCall()) return
    const local = useCallStore.getState().localStream
    if (!local) return

    let camera = cameraFeedRef.current

    // No camera track -> acquire and turn ON.
    if (!camera || camera.readyState === 'ended') {
      try {
        const prefs = loadMediaPrefs()
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: getUserMediaConstraints({ video: true, hd: !prefs.lowBandwidth }).video,
          audio: false,
        })
        camera = camStream.getVideoTracks()[0] ?? null
      } catch (err) {
        setMediaAccessError(isMediaPermissionDenied(err) ? MEDIA_PERMISSION_DENIED_CODE : MEDIA_ACCESS_ERROR_MESSAGE)
        return
      }
      if (!camera) return
      // Background effects (blur / image replacement) wrap the raw track.
      camera = await wrapCameraTrack(camera)
      cameraFeedRef.current = camera
      camera.enabled = true
      // The camera is fully independent of the screen share now — publish it
      // on the CAMERA slot (excluding the screen's own sender).
      if (!local.getVideoTracks().includes(camera)) local.addTrack(camera)
      pcsRef.current.forEach(pc => applyVideoTrack(pc, camera, local, screenFeedRef.current))
      setLocalStream(local)
      bumpLocalMediaRev()
      setIsCameraOn(true)
      broadcastVideoState(true)
      return
    }

    // Existing camera track -> HARD off. `enabled = false` alone kept the
    // device open (webcam LED stayed on — issue: "выключение не отключает").
    // stopCameraTrack also tears down the effects chain, releasing the RAW
    // hardware track hidden inside it.
    pcsRef.current.forEach(pc => applyVideoTrack(pc, null, local, screenFeedRef.current))
    broadcastVideoState(false)
    if (local.getVideoTracks().includes(camera)) local.removeTrack(camera)
    stopCameraTrack(camera)
    cameraFeedRef.current = null
    setLocalStream(local)
    bumpLocalMediaRev()
    setIsCameraOn(false)
  }, [broadcastVideoState, isRelayOnlyCall, setLocalStream, bumpLocalMediaRev, wrapCameraTrack, stopCameraTrack])

  /**
   * List available camera (videoinput) devices. Used by the desktop in-call
   * camera selector. Labels are only populated once media permission is granted.
   */
  const listCameras = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'videoinput')
    } catch {
      return []
    }
  }, [])

  /**
   * Switch the active camera.
   *  - Desktop: pass a concrete `deviceId` chosen from the camera selector.
   *  - Mobile: pass nothing — flips facingMode between user/environment.
   * No-op while screen-sharing or when the camera is off.
   */
  const switchCamera = useCallback(async (deviceId?: string) => {
    const local = useCallStore.getState().localStream
    if (!local) return
    const oldTrack = cameraFeedRef.current
    if (!oldTrack) return

    const nextMode: 'user' | 'environment' =
      facingModeRef.current === 'user' ? 'environment' : 'user'
    const videoConstraint: MediaTrackConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 } }
      : { facingMode: { ideal: nextMode }, width: { ideal: 1280 } }

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: false,
      })
      const rawTrack = newStream.getVideoTracks()[0]
      if (!rawTrack) return

      const wasEnabled = oldTrack.enabled
      // Re-wrap the NEW device through the effects chain (wrapCameraTrack
      // disposes the previous chain, which also stops the previous raw track).
      const newTrack = await wrapCameraTrack(rawTrack)
      // Preserve the prior on/off state on the replacement track.
      newTrack.enabled = wasEnabled

      pcsRef.current.forEach(pc => applyVideoTrack(pc, newTrack, local, screenFeedRef.current))

      if (local.getVideoTracks().includes(oldTrack)) local.removeTrack(oldTrack)
      oldTrack.stop()
      local.addTrack(newTrack)
      cameraFeedRef.current = newTrack
      if (!deviceId) facingModeRef.current = nextMode
      setLocalStream(local)
      bumpLocalMediaRev()
    } catch (err) {
      console.error('[SYS.MEDIA] CAMERA_SWITCH_FAULT:', err)
    }
  }, [setLocalStream, bumpLocalMediaRev, wrapCameraTrack])

  /**
   * Toggle screen-share. Acquires the screen via getDisplayMedia ONLY — it never
   * calls getUserMedia and never enables the camera track. The screen video
   * track replaces the video sender; stopping it restores the prior camera
   * state via revertToOptics().
   */
  const toggleScreenShare = useCallback(async () => {
    if (isRelayOnlyCall()) return
    if (isScreenSharing) {
      revertToOptics()
      return
    }

    if (!useCallStore.getState().localStream) return

    let screenStream: MediaStream
    try {
      // Options honor the screen-share prefs: audio capture (with the
      // system-audio checkbox forced on in the Chrome picker), quality caps
      // and surface switching. See getDisplayMediaOptions.
      screenStream = await navigator.mediaDevices.getDisplayMedia(getDisplayMediaOptions())
    } catch (err) {
      if ((err as Error)?.name !== 'NotAllowedError') {
        console.error('[SYS.MEDIA] SCREENSHARE_FAULT:', err)
      }
      return
    }

    const screenVideoTrack = screenStream.getVideoTracks()[0]
    if (!screenVideoTrack) {
      screenStream.getTracks().forEach(t => t.stop())
      return
    }
    applyScreenTrackSettings(screenVideoTrack)
    const screenAudioTrack = screenStream.getAudioTracks()[0] ?? null

    // The screen goes out on its OWN senders under a DEDICATED msid — the
    // camera keeps its slot untouched, so face + screen flow simultaneously
    // (Discord-style). The msid is announced via the screen_share signal
    // BEFORE the tracks are added, so the receiver routes the renegotiated
    // tracks into a separate `peer#screen` tile instead of clobbering the
    // main stream entry.
    const msidStream = new MediaStream()
    screenMsidStreamRef.current = msidStream
    screenFeedRef.current = screenVideoTrack
    screenAudioFeedRef.current = screenAudioTrack

    pcsRef.current.forEach((_, id) =>
      transmitSignal(id, { kind: 'screen_share', active: true, streamId: msidStream.id })
    )
    relayPeersRef.current.forEach((id) =>
      transmitSignal(id, { kind: 'screen_share', active: true, streamId: msidStream.id })
    )

    pcsRef.current.forEach((pc, id) => {
      const videoSender = pc.addTrack(screenVideoTrack, msidStream)
      const entry: { video: RTCRtpSender; audio?: RTCRtpSender } = { video: videoSender }
      if (screenAudioTrack) {
        entry.audio = pc.addTrack(screenAudioTrack, msidStream)
      }
      screenSendersRef.current.set(id, entry)
    })

    setLocalScreenStream(new MediaStream([screenVideoTrack]))
    setIsScreenSharing(true)
    setHasScreenAudio(!!screenAudioTrack)
    setIsScreenAudioMuted(false)
    bumpLocalMediaRev()

    // Encoder budget for the chosen preset — 4K/120fps are unusable on the
    // default ~2.5 Mbps cap (see getScreenShareMaxBitrateBps).
    {
      const prefs = loadMediaPrefs()
      const maxBitrate = getScreenShareMaxBitrateBps(prefs.screenRes, prefs.screenFps)
      const degradation = getScreenShareDegradationPreference(prefs.screenContent)
      pcsRef.current.forEach((pc) => {
        void tuneScreenShareSender(pc, screenVideoTrack, maxBitrate, degradation)
      })
    }

    // "Stop sharing" from the browser-native control tears everything down.
    screenVideoTrack.onended = () => {
      revertToOptics()
    }
  }, [isRelayOnlyCall, isScreenSharing, revertToOptics, bumpLocalMediaRev])

  /**
   * Locally mute/unmute the captured screen-share AUDIO without touching the
   * video. Flips the track's `enabled` flag — peers receive silence while
   * muted, no renegotiation.
   */
  const toggleScreenAudioMuted = useCallback(() => {
    const track = screenAudioFeedRef.current
    if (!track) return
    track.enabled = !track.enabled
    setIsScreenAudioMuted(!track.enabled)
  }, [])

  /**
   * Switch the camera background effect. Persists the pref and applies it to
   * the LIVE camera without renegotiation when possible:
   *  - chain already running → just retarget it (blur ⇄ image ⇄ passthrough);
   *  - camera on RAW and effect requested → wrap the live track and swap the
   *    published track via replaceTrack;
   *  - camera off → the pref simply applies on the next camera-on.
   */
  const setCameraEffect = useCallback(async (kind: CameraEffectPref) => {
    saveMediaPrefs({ camEffect: kind })
    const imageDataUrl = loadCamEffectImage()
    const chain = camFxRef.current
    if (chain) {
      chain.setEffect(kind, imageDataUrl)
      return
    }
    if (kind === 'none') return
    const raw = cameraFeedRef.current
    const local = useCallStore.getState().localStream
    if (!raw || raw.readyState !== 'live' || !local) return
    try {
      const handle = await createEffectedCameraTrack(raw, { kind, imageDataUrl })
      if (!handle) return
      camFxRef.current = handle
      const processed = handle.processedTrack
      processed.enabled = raw.enabled
      pcsRef.current.forEach(pc => applyVideoTrack(pc, processed, local, screenFeedRef.current))
      if (local.getVideoTracks().includes(raw)) local.removeTrack(raw)
      if (!local.getVideoTracks().includes(processed)) {
        local.addTrack(processed)
      }
      cameraFeedRef.current = processed
      setLocalStream(local)
      bumpLocalMediaRev()
    } catch (err) {
      console.warn('[SYS.MEDIA] camera effect switch failed', err)
    }
  }, [setLocalStream, bumpLocalMediaRev])

  return {
    peerReady,
    mediaAccessError,
    clearMediaAccessError: () => setMediaAccessError(null),
    initiateCall: establishLink,
    acceptIncomingCall: acceptLink,
    rejectIncomingCall: rejectLink,
    endCall: severAllLinks,
    toggleMuteMic: toggleMute,
    toggleCamera,
    toggleVideo: toggleCamera,
    isCameraOn,
    listCameras,
    switchCamera,
    isScreenSharing,
    toggleScreenShare,
    localScreenStream,
    hasScreenAudio,
    isScreenAudioMuted,
    toggleScreenAudioMuted,
    setQuality,
    setCameraEffect,
    promoteToGroup,
  }
}

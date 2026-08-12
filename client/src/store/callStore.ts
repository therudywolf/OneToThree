import { create } from 'zustand'

/**
 * PROJECT 13 :: CALL_PROTOCOL_STORAGE
 * Level: Session Layer (Pulse Control)
 * Vibe: Clinical Pure / Terminal Noir
 */

export type InboundLinkRequest = {
  peerId: string
  chatId?: string
  peerUsername?: string
  isVideo?: boolean
  offer?: RTCSessionDescriptionInit | null
  transport?: 'webrtc' | 'audio_relay'
}

/** Состояние периферии удаленного узла (оптика/акустика) */
export type NodeMediaState = {
  micMuted: boolean
  cameraOff: boolean
  screenSharing: boolean
}

/** Connection quality stats from RTCPeerConnection getStats(). */
export type ConnectionQuality = {
  rtt: number | null
  outgoingBitrate: number | null
  poor: boolean
}

/** P2P vs relay connection type per peer */
export type PeerConnectionType = 'p2p' | 'relay' | 'unknown'

/** Granular video quality levels */
export type QualityLevel = 'auto' | '720p' | '480p' | '360p' | 'audio_only'

export type CallProtocolState = {
  // [FEED_LAYER]
  localStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>

  // [SIGNAL_LAYER]
  remotePeerMedia: Record<string, NodeMediaState>
  peerConnections: Record<string, RTCPeerConnection>

  // [STATUS_LAYER]
  isCalling: boolean
  isReconnecting: boolean
  isConnectionLost: boolean
  iceRetryCount: number
  connectionQuality: ConnectionQuality | null
  incomingCall: InboundLinkRequest | null
  peerConnectionTypes: Record<string, PeerConnectionType>
  qualityLevel: QualityLevel
  /** Chat id of the ACTIVE call — used to send call_leave to the right chat
   * even if the user navigated to a different chat mid-call. */
  callChatId: string | null

  // [MINI_PLAYER]
  isMiniPlayer: boolean
  callStartTime: number | null
  showRelayToast: boolean

  // [DND]
  dndEnabled: boolean

  // [DEAFEN] — output mute: silence ALL remote call audio without leaving the
  // call. Shared flag for 1:1 and group (a user is only ever in one at a time).
  deafened: boolean

  // [PER_PEER_AUDIO] — local-only volume (0..1) and mute-for-me per peer.
  // Shared between 1:1 and group (keys are user ids; a user is only ever in
  // one call at a time). Applied by CallAudioSink; never signalled to peers.
  peerVolumes: Record<string, number>
  peerLocalMuted: Record<string, boolean>

  // [SIDE_PANELS] — in-call side panel (participants / debug) and the
  // Discord-style side chat. Chat is a store flag (not overlay-local state)
  // because ChatApp renders the actual chat panel next to the shrunk overlay.
  sidePanel: 'none' | 'participants' | 'debug'
  chatOpen: boolean

  // [LOCAL_MEDIA_REV] — bumped after every LOCAL stream mutation (camera
  // on/off, screen share, device switch). Script-added tracks fire NO events
  // (`addtrack` is UA-only) and the stream keeps its identity, so tiles need
  // an explicit signal to re-read track state.
  localMediaRev: number

  // [ACTIONS]
  setLocalStream: (feed: MediaStream | null) => void
  setRemoteStream: (peerId: string, feed: MediaStream) => void
  removeRemoteStream: (peerId: string) => void

  setRemotePeerMedia: (peerId: string, patch: Partial<NodeMediaState>) => void
  clearRemotePeerMedia: (peerId: string) => void

  setIncomingCall: (request: InboundLinkRequest | null) => void
  setIsCalling: (active: boolean) => void
  setReconnecting: (value: boolean) => void
  setConnectionLost: (value: boolean) => void
  setIceRetryCount: (count: number) => void
  setConnectionQuality: (quality: ConnectionQuality | null) => void

  addPeerConnection: (peerId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (peerId: string) => void

  setPeerConnectionType: (peerId: string, type: PeerConnectionType) => void
  clearPeerConnectionType: (peerId: string) => void
  setQualityLevel: (level: QualityLevel) => void

  setMiniPlayer: (value: boolean) => void
  setCallStartTime: (time: number | null) => void
  setShowRelayToast: (value: boolean) => void
  setDndEnabled: (v: boolean) => void
  setDeafened: (v: boolean) => void
  setCallChatId: (chatId: string | null) => void
  setPeerVolume: (peerId: string, volume: number) => void
  setPeerLocalMuted: (peerId: string, muted: boolean) => void
  setSidePanel: (panel: 'none' | 'participants' | 'debug') => void
  setChatOpen: (open: boolean) => void
  bumpLocalMediaRev: () => void

  /** Полная деактивация протокола и очистка контура */
  reset: () => void
}

const INITIAL_MEDIA_STATE = (): NodeMediaState => ({
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
})

const QUALITY_STORAGE_KEY = 'p13_quality_level'

function loadQualityLevel(): QualityLevel {
  if (typeof window === 'undefined') return 'auto'
  const v = window.localStorage.getItem(QUALITY_STORAGE_KEY)
  if (v === '720p' || v === '480p' || v === '360p' || v === 'audio_only') return v
  return 'auto'
}

function loadDndEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem('p13:dnd') === '1'
}

export const useCallStore = create<CallProtocolState>((set, get) => {
  const setLocalStream = (feed: MediaStream | null) => set({ localStream: feed })
  const setRemoteStream = (peerId: string, feed: MediaStream) =>
    set((state) => ({ remoteStreams: { ...state.remoteStreams, [peerId]: feed } }))
  const removeRemoteStream = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.remoteStreams; return { remoteStreams: rest } })
  const setRemotePeerMedia = (peerId: string, patch: Partial<NodeMediaState>) =>
    set((state) => ({
      remotePeerMedia: { ...state.remotePeerMedia, [peerId]: { ...(state.remotePeerMedia[peerId] ?? INITIAL_MEDIA_STATE()), ...patch } },
    }))
  const clearRemotePeerMedia = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.remotePeerMedia; return { remotePeerMedia: rest } })
  const setIncomingCall = (request: InboundLinkRequest | null) => set({ incomingCall: request })
  const setIsCalling = (active: boolean) => set({ isCalling: active })
  const setReconnecting = (value: boolean) => set({ isReconnecting: value })
  const setConnectionLost = (value: boolean) => set({ isConnectionLost: value })
  const setIceRetryCount = (count: number) => set({ iceRetryCount: count })
  const setConnectionQuality = (quality: ConnectionQuality | null) => set({ connectionQuality: quality })
  const addPeerConnection = (peerId: string, pc: RTCPeerConnection) =>
    set((state) => ({ peerConnections: { ...state.peerConnections, [peerId]: pc } }))
  const removePeerConnection = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.peerConnections; return { peerConnections: rest } })
  const setPeerConnectionType = (peerId: string, type: PeerConnectionType) =>
    set((state) => ({ peerConnectionTypes: { ...state.peerConnectionTypes, [peerId]: type } }))
  const clearPeerConnectionType = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.peerConnectionTypes; return { peerConnectionTypes: rest } })
  const setQualityLevel = (level: QualityLevel) => {
    try { window.localStorage.setItem(QUALITY_STORAGE_KEY, level) } catch { /* storage unavailable */ }
    set({ qualityLevel: level })
  }
  const setMiniPlayer = (value: boolean) => set({ isMiniPlayer: value })
  const setCallStartTime = (time: number | null) => set({ callStartTime: time })
  const setShowRelayToast = (value: boolean) => set({ showRelayToast: value })
  const setDndEnabled = (v: boolean) => {
    try { window.localStorage.setItem('p13:dnd', v ? '1' : '0') } catch { /* storage unavailable */ }
    set({ dndEnabled: v })
  }
  const setCallChatId = (chatId: string | null) => set({ callChatId: chatId })
  const setDeafened = (v: boolean) => set({ deafened: v })
  const setPeerVolume = (peerId: string, volume: number) =>
    set((state) => ({
      peerVolumes: { ...state.peerVolumes, [peerId]: Math.min(1, Math.max(0, volume)) },
    }))
  const setPeerLocalMuted = (peerId: string, muted: boolean) =>
    set((state) => ({ peerLocalMuted: { ...state.peerLocalMuted, [peerId]: muted } }))
  const setSidePanel = (panel: 'none' | 'participants' | 'debug') => set({ sidePanel: panel })
  const setChatOpen = (open: boolean) => set({ chatOpen: open })
  const bumpLocalMediaRev = () => set((state) => ({ localMediaRev: state.localMediaRev + 1 }))
  const reset = () => {
    // FIX 9: Close peer connections and stop media tracks before clearing state
    const state = get()
    for (const pc of Object.values(state.peerConnections)) {
      try { pc.close() } catch { /* ignore */ }
    }
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        try { track.stop() } catch { /* ignore */ }
      }
    }
    for (const stream of Object.values(state.remoteStreams)) {
      for (const track of stream.getTracks()) {
        try { track.stop() } catch { /* ignore */ }
      }
    }
    set({ localStream: null, remoteStreams: {}, remotePeerMedia: {}, peerConnections: {}, isCalling: false, isReconnecting: false, isConnectionLost: false, iceRetryCount: 0, connectionQuality: null, incomingCall: null, peerConnectionTypes: {}, isMiniPlayer: false, callStartTime: null, showRelayToast: false, deafened: false, callChatId: null, peerVolumes: {}, peerLocalMuted: {}, sidePanel: 'none', chatOpen: false })
  }

  return {
    localStream: null,
    remoteStreams: {},
    remotePeerMedia: {},
    peerConnections: {},
    isCalling: false,
    isReconnecting: false,
    isConnectionLost: false,
    iceRetryCount: 0,
    connectionQuality: null,
    incomingCall: null,
    peerConnectionTypes: {},
    qualityLevel: loadQualityLevel(),
    callChatId: null,
    isMiniPlayer: false,
    callStartTime: null,
    showRelayToast: false,
    dndEnabled: loadDndEnabled(),
    deafened: false,
    peerVolumes: {},
    peerLocalMuted: {},
    sidePanel: 'none',
    chatOpen: false,
    localMediaRev: 0,

    setLocalStream,
    setRemoteStream,
    removeRemoteStream,
    setRemotePeerMedia,
    clearRemotePeerMedia,
    setIncomingCall,
    setIsCalling,
    setReconnecting,
    setConnectionLost,
    setIceRetryCount,
    setConnectionQuality,
    addPeerConnection,
    removePeerConnection,
    setPeerConnectionType,
    clearPeerConnectionType,
    setQualityLevel,
    setMiniPlayer,
    setCallStartTime,
    setShowRelayToast,
    setDndEnabled,
    setDeafened,
    setCallChatId,
    setPeerVolume,
    setPeerLocalMuted,
    setSidePanel,
    setChatOpen,
    bumpLocalMediaRev,
    reset,
  }
})

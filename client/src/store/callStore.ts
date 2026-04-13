import { create } from 'zustand'

/**
 * PROJECT 13 :: CALL_PROTOCOL_STORAGE
 * Level: Session Layer (Pulse Control)
 * Vibe: Clinical Pure / Terminal Noir
 */

export type InboundLinkRequest = {
  peerId: string
  isVideo?: boolean
  offer: RTCSessionDescriptionInit
}

/** Состояние периферии удаленного узла (оптика/акустика) */
export type NodeMediaState = {
  micMuted: boolean
  cameraOff: boolean
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
  connectionQuality: ConnectionQuality | null
  incomingCall: InboundLinkRequest | null
  peerConnectionTypes: Record<string, PeerConnectionType>
  qualityLevel: QualityLevel

  // [ACTIONS]
  setLocalStream: (feed: MediaStream | null) => void
  setRemoteStream: (peerId: string, feed: MediaStream) => void
  removeRemoteStream: (peerId: string) => void

  setRemotePeerMedia: (peerId: string, patch: Partial<NodeMediaState>) => void
  clearRemotePeerMedia: (peerId: string) => void

  setIncomingCall: (request: InboundLinkRequest | null) => void
  setIsCalling: (active: boolean) => void
  setReconnecting: (value: boolean) => void
  setConnectionQuality: (quality: ConnectionQuality | null) => void

  addPeerConnection: (peerId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (peerId: string) => void

  setPeerConnectionType: (peerId: string, type: PeerConnectionType) => void
  clearPeerConnectionType: (peerId: string) => void
  setQualityLevel: (level: QualityLevel) => void

  /** Полная деактивация протокола и очистка контура */
  reset: () => void
}

const INITIAL_MEDIA_STATE = (): NodeMediaState => ({
  micMuted: false,
  cameraOff: false,
})

const QUALITY_STORAGE_KEY = 'p13_quality_level'

function loadQualityLevel(): QualityLevel {
  if (typeof window === 'undefined') return 'auto'
  const v = window.localStorage.getItem(QUALITY_STORAGE_KEY)
  if (v === '720p' || v === '480p' || v === '360p' || v === 'audio_only') return v
  return 'auto'
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
    try { window.localStorage.setItem(QUALITY_STORAGE_KEY, level) } catch {}
    set({ qualityLevel: level })
  }
  const reset = () =>
    set({ localStream: null, remoteStreams: {}, remotePeerMedia: {}, peerConnections: {}, isCalling: false, isReconnecting: false, connectionQuality: null, incomingCall: null, peerConnectionTypes: {} })

  return {
    localStream: null,
    remoteStreams: {},
    remotePeerMedia: {},
    peerConnections: {},
    isCalling: false,
    isReconnecting: false,
    connectionQuality: null,
    incomingCall: null,
    peerConnectionTypes: {},
    qualityLevel: loadQualityLevel(),

    setLocalStream,
    setRemoteStream,
    removeRemoteStream,
    setRemotePeerMedia,
    clearRemotePeerMedia,
    setIncomingCall,
    setIsCalling,
    setReconnecting,
    setConnectionQuality,
    addPeerConnection,
    removePeerConnection,
    setPeerConnectionType,
    clearPeerConnectionType,
    setQualityLevel,
    reset,
  }
})

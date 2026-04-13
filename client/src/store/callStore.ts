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

  /** Полная деактивация протокола и очистка контура */
  reset: () => void
}

const INITIAL_MEDIA_STATE = (): NodeMediaState => ({
  micMuted: false,
  cameraOff: false,
})

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
  const reset = () =>
    set({ localStream: null, remoteStreams: {}, remotePeerMedia: {}, peerConnections: {}, isCalling: false, isReconnecting: false, connectionQuality: null, incomingCall: null })

  return {
    localStream: null,
    remoteStreams: {},
    remotePeerMedia: {},
    peerConnections: {},
    isCalling: false,
    isReconnecting: false,
    connectionQuality: null,
    incomingCall: null,

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
    reset,
  }
})

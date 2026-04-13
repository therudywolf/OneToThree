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

export type CallProtocolState = {
  // [FEED_LAYER]
  localFeed: MediaStream | null
  remoteFeeds: Record<string, MediaStream>

  // [SIGNAL_LAYER]
  nodeHints: Record<string, NodeMediaState>
  signalLinks: Record<string, RTCPeerConnection>

  // [STATUS_LAYER]
  isLinkActive: boolean
  inboundRequest: InboundLinkRequest | null

  // [ACTIONS]
  setLocalFeed: (feed: MediaStream | null) => void
  setRemoteFeed: (peerId: string, feed: MediaStream) => void
  dropRemoteFeed: (peerId: string) => void

  updateNodeHint: (peerId: string, patch: Partial<NodeMediaState>) => void
  purgeNodeHint: (peerId: string) => void

  setInboundRequest: (request: InboundLinkRequest | null) => void
  setLinkStatus: (active: boolean) => void

  registerSignalLink: (peerId: string, pc: RTCPeerConnection) => void
  severSignalLink: (peerId: string) => void

  /** Полная деактивация протокола и очистка контура */
  resetProtocol: () => void

  // --- CONSUMER_ALIASES ---
  isCalling: boolean
  localStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>
  remotePeerMedia: Record<string, NodeMediaState>
  incomingCall: InboundLinkRequest | null
  setIncomingCall: (request: InboundLinkRequest | null) => void
  reset: () => void
  addPeerConnection: (peerId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (peerId: string) => void
  setRemoteStream: (peerId: string, feed: MediaStream) => void
  removeRemoteStream: (peerId: string) => void
  setLocalStream: (feed: MediaStream | null) => void
  setIsCalling: (active: boolean) => void
  clearRemotePeerMedia: (peerId: string) => void
  setRemotePeerMedia: (peerId: string, patch: Partial<NodeMediaState>) => void
  peerConnections: Record<string, RTCPeerConnection>
}

const INITIAL_MEDIA_STATE = (): NodeMediaState => ({
  micMuted: false,
  cameraOff: false,
})

export const useCallStore = create<CallProtocolState>((set, get) => {
  const setLocalFeed = (feed: MediaStream | null) => set({ localFeed: feed })
  const setRemoteFeed = (peerId: string, feed: MediaStream) =>
    set((state) => ({ remoteFeeds: { ...state.remoteFeeds, [peerId]: feed } }))
  const dropRemoteFeed = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.remoteFeeds; return { remoteFeeds: rest } })
  const updateNodeHint = (peerId: string, patch: Partial<NodeMediaState>) =>
    set((state) => ({
      nodeHints: { ...state.nodeHints, [peerId]: { ...(state.nodeHints[peerId] ?? INITIAL_MEDIA_STATE()), ...patch } },
    }))
  const purgeNodeHint = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.nodeHints; return { nodeHints: rest } })
  const setInboundRequest = (request: InboundLinkRequest | null) => set({ inboundRequest: request })
  const setLinkStatus = (active: boolean) => set({ isLinkActive: active })
  const registerSignalLink = (peerId: string, pc: RTCPeerConnection) =>
    set((state) => ({ signalLinks: { ...state.signalLinks, [peerId]: pc } }))
  const severSignalLink = (peerId: string) =>
    set((state) => { const { [peerId]: _, ...rest } = state.signalLinks; return { signalLinks: rest } })
  const resetProtocol = () =>
    set({ localFeed: null, remoteFeeds: {}, nodeHints: {}, signalLinks: {}, isLinkActive: false, inboundRequest: null })

  return {
    localFeed: null,
    remoteFeeds: {},
    nodeHints: {},
    signalLinks: {},
    isLinkActive: false,
    inboundRequest: null,

    setLocalFeed,
    setRemoteFeed,
    dropRemoteFeed,
    updateNodeHint,
    purgeNodeHint,
    setInboundRequest,
    setLinkStatus,
    registerSignalLink,
    severSignalLink,
    resetProtocol,

    // Consumer aliases (state)
    isCalling: false,
    localStream: null,
    remoteStreams: {},
    remotePeerMedia: {},
    incomingCall: null,
    peerConnections: {},

    // Consumer aliases (actions)
    setIncomingCall: setInboundRequest,
    reset: resetProtocol,
    addPeerConnection: registerSignalLink,
    removePeerConnection: severSignalLink,
    setRemoteStream: setRemoteFeed,
    removeRemoteStream: dropRemoteFeed,
    setLocalStream: setLocalFeed,
    setIsCalling: setLinkStatus,
    clearRemotePeerMedia: purgeNodeHint,
    setRemotePeerMedia: updateNodeHint,
  }
})

// Keep consumer alias state fields in sync
useCallStore.subscribe((state) => {
  const needsSync =
    state.isCalling !== state.isLinkActive ||
    state.localStream !== state.localFeed ||
    state.remoteStreams !== state.remoteFeeds ||
    state.remotePeerMedia !== state.nodeHints ||
    state.incomingCall !== state.inboundRequest ||
    state.peerConnections !== state.signalLinks

  if (needsSync) {
    useCallStore.setState({
      isCalling: state.isLinkActive,
      localStream: state.localFeed,
      remoteStreams: state.remoteFeeds,
      remotePeerMedia: state.nodeHints,
      incomingCall: state.inboundRequest,
      peerConnections: state.signalLinks,
    }, false)
  }
})
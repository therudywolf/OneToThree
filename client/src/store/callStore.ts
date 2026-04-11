import { create } from 'zustand'

export type IncomingCallInfo = {
  peerId: string
  isVideo?: boolean
  offer: RTCSessionDescriptionInit
}

/** Remote peer media hints from WebSocket `media_state` signals (not inferred from tracks). */
export type RemotePeerMedia = { micMuted: boolean; cameraOff: boolean }

type CallState = {
  localStream: MediaStream | null
  /** Remote peer id → MediaStream */
  remoteStreams: Record<string, MediaStream>
  /** Signaled mute/cam-off from peer (WebRTC signal), keyed by peer id. */
  remotePeerMedia: Record<string, RemotePeerMedia>
  isCalling: boolean
  incomingCall: IncomingCallInfo | null
  peerConnections: Record<string, RTCPeerConnection>
  setLocalStream: (s: MediaStream | null) => void
  setRemoteStream: (peerId: string, stream: MediaStream) => void
  removeRemoteStream: (peerId: string) => void
  setRemotePeerMedia: (
    peerId: string,
    partial: Partial<RemotePeerMedia>
  ) => void
  clearRemotePeerMedia: (peerId: string) => void
  setIncomingCall: (info: IncomingCallInfo | null) => void
  setIsCalling: (v: boolean) => void
  addPeerConnection: (peerId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (peerId: string) => void
  reset: () => void
}

const defaultRemoteMedia = (): RemotePeerMedia => ({
  micMuted: false,
  cameraOff: false,
})

export const useCallStore = create<CallState>((set) => ({
  localStream: null,
  remoteStreams: {},
  remotePeerMedia: {},
  isCalling: false,
  incomingCall: null,
  peerConnections: {},
  setLocalStream: (s) => set({ localStream: s }),
  setRemoteStream: (peerId, stream) =>
    set((state) => ({
      remoteStreams: { ...state.remoteStreams, [peerId]: stream },
    })),
  removeRemoteStream: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.remoteStreams
      return { remoteStreams: rest }
    }),
  setRemotePeerMedia: (peerId, partial) =>
    set((state) => {
      const cur = state.remotePeerMedia[peerId] ?? defaultRemoteMedia()
      return {
        remotePeerMedia: {
          ...state.remotePeerMedia,
          [peerId]: { ...cur, ...partial },
        },
      }
    }),
  clearRemotePeerMedia: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.remotePeerMedia
      return { remotePeerMedia: rest }
    }),
  setIncomingCall: (info) => set({ incomingCall: info }),
  setIsCalling: (v) => set({ isCalling: v }),
  addPeerConnection: (peerId, pc) =>
    set((state) => ({
      peerConnections: { ...state.peerConnections, [peerId]: pc },
    })),
  removePeerConnection: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.peerConnections
      return { peerConnections: rest }
    }),
  reset: () =>
    set({
      localStream: null,
      remoteStreams: {},
      remotePeerMedia: {},
      isCalling: false,
      incomingCall: null,
      peerConnections: {},
    }),
}))

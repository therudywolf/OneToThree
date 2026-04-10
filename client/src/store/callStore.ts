import { create } from 'zustand'

export type IncomingCallInfo = {
  peerId: string
  isVideo?: boolean
  offer: RTCSessionDescriptionInit
}

type CallState = {
  localStream: MediaStream | null
  /** Remote peer id → MediaStream */
  remoteStreams: Record<string, MediaStream>
  isCalling: boolean
  incomingCall: IncomingCallInfo | null
  peerConnections: Record<string, RTCPeerConnection>
  setLocalStream: (s: MediaStream | null) => void
  setRemoteStream: (peerId: string, stream: MediaStream) => void
  removeRemoteStream: (peerId: string) => void
  setIncomingCall: (info: IncomingCallInfo | null) => void
  setIsCalling: (v: boolean) => void
  addPeerConnection: (peerId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (peerId: string) => void
  reset: () => void
}

export const useCallStore = create<CallState>((set) => ({
  localStream: null,
  remoteStreams: {},
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
      isCalling: false,
      incomingCall: null,
      peerConnections: {},
    }),
}))

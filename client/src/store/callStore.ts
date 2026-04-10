import { create } from 'zustand'

/** Minimal surface for signaling / RTCPeerConnection wiring (Phase 2). */
export type MediaSessionHandle = {
  close: () => void
  answer: (stream: MediaStream) => void
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

export type IncomingCallInfo = {
  peerId: string
  call: MediaSessionHandle
  isVideo?: boolean
}

type CallState = {
  localStream: MediaStream | null
  /** Remote peer id → MediaStream */
  remoteStreams: Record<string, MediaStream>
  isCalling: boolean
  incomingCall: IncomingCallInfo | null
  connections: Record<string, MediaSessionHandle>
  setLocalStream: (s: MediaStream | null) => void
  setRemoteStream: (peerId: string, stream: MediaStream) => void
  removeRemoteStream: (peerId: string) => void
  setIncomingCall: (info: IncomingCallInfo | null) => void
  setIsCalling: (v: boolean) => void
  setConnection: (peerId: string, c: MediaSessionHandle) => void
  removeConnection: (peerId: string) => void
  reset: () => void
}

export const useCallStore = create<CallState>((set) => ({
  localStream: null,
  remoteStreams: {},
  isCalling: false,
  incomingCall: null,
  connections: {},
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
  setConnection: (peerId, c) =>
    set((state) => ({
      connections: { ...state.connections, [peerId]: c },
    })),
  removeConnection: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.connections
      return { connections: rest }
    }),
  reset: () =>
    set({
      localStream: null,
      remoteStreams: {},
      isCalling: false,
      incomingCall: null,
      connections: {},
    }),
}))

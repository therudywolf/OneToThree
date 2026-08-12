import { create } from 'zustand'

/**
 * PROJECT 13 :: GROUP_CALL_PROTOCOL_STORAGE
 * Level: Session Layer (Mesh Coordination)
 * Vibe: Clinical Pure / Terminal Noir
 */

export type GroupCallParticipant = {
  userId: string
  username: string
  isMuted: boolean
  isVideoOff: boolean
  isSpeaking: boolean
  connectionState: RTCIceConnectionState | 'new' | 'pending'
}

export type GroupCallTransport = 'mesh' | 'livekit' | 'audio_relay'

export type GroupCallState = {
  // [CALL_STATE]
  isInGroupCall: boolean
  roomId: string | null
  isVideo: boolean
  transport: GroupCallTransport
  isScreenSharing: boolean

  // [STREAMS]
  localStream: MediaStream | null
  /** Local preview of the OWN screen share (dual camera+screen, mesh). */
  localScreenStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>

  // [PARTICIPANTS]
  participants: Record<string, GroupCallParticipant>

  // [PEER_CONNECTIONS]
  peerConnections: Record<string, RTCPeerConnection>

  // [UI_STATE]
  showParticipantPanel: boolean
  showChatPanel: boolean
  isMiniPlayer: boolean
  /** Bumped after every LOCAL stream mutation — script-added tracks fire no
   * events, so tiles re-read track state off this counter. */
  localMediaRev: number
  /** Epoch ms when the group call started — held in the store so the in-call
   *  timer survives minimize→expand remounts instead of resetting to 00:00 (#12). */
  callStartTime: number | null
  activeCallBanner: Record<string, number> // roomId -> participant count for rooms with active calls

  // [ACTIONS]
  setIsInGroupCall: (active: boolean) => void
  setRoomId: (roomId: string | null) => void
  setIsVideo: (isVideo: boolean) => void
  setTransport: (transport: GroupCallTransport) => void
  setIsScreenSharing: (sharing: boolean) => void
  setLocalStream: (stream: MediaStream | null) => void
  setLocalScreenStream: (stream: MediaStream | null) => void
  setRemoteStream: (userId: string, stream: MediaStream) => void
  removeRemoteStream: (userId: string) => void
  setParticipant: (userId: string, participant: GroupCallParticipant) => void
  updateParticipant: (userId: string, patch: Partial<GroupCallParticipant>) => void
  removeParticipant: (userId: string) => void
  addPeerConnection: (userId: string, pc: RTCPeerConnection) => void
  removePeerConnection: (userId: string) => void
  setShowParticipantPanel: (show: boolean) => void
  setShowChatPanel: (show: boolean) => void
  setIsMiniPlayer: (mini: boolean) => void
  bumpLocalMediaRev: () => void
  setCallStartTime: (t: number | null) => void
  setActiveCallBanner: (roomId: string, count: number) => void
  clearActiveCallBanner: (roomId: string) => void
  reset: () => void
}

export const useGroupCallStore = create<GroupCallState>((set, get) => ({
  isInGroupCall: false,
  roomId: null,
  isVideo: false,
  transport: 'mesh',
  isScreenSharing: false,
  localStream: null,
  localScreenStream: null,
  remoteStreams: {},
  participants: {},
  peerConnections: {},
  showParticipantPanel: false,
  showChatPanel: false,
  isMiniPlayer: false,
  localMediaRev: 0,
  callStartTime: null,
  activeCallBanner: {},

  setIsInGroupCall: (active) => set({ isInGroupCall: active }),
  setRoomId: (roomId) => set({ roomId }),
  setIsVideo: (isVideo) => set({ isVideo }),
  setTransport: (transport) => set({ transport }),
  setIsScreenSharing: (sharing) => set({ isScreenSharing: sharing }),
  setLocalStream: (stream) => set({ localStream: stream }),
  setLocalScreenStream: (stream) => set({ localScreenStream: stream }),
  setRemoteStream: (userId, stream) =>
    set((s) => ({ remoteStreams: { ...s.remoteStreams, [userId]: stream } })),
  removeRemoteStream: (userId) =>
    set((s) => {
      const { [userId]: _, ...rest } = s.remoteStreams
      return { remoteStreams: rest }
    }),
  setParticipant: (userId, participant) =>
    set((s) => ({ participants: { ...s.participants, [userId]: participant } })),
  updateParticipant: (userId, patch) =>
    set((s) => {
      const existing = s.participants[userId]
      if (!existing) return s
      return { participants: { ...s.participants, [userId]: { ...existing, ...patch } } }
    }),
  removeParticipant: (userId) =>
    set((s) => {
      const { [userId]: _, ...rest } = s.participants
      return { participants: rest }
    }),
  addPeerConnection: (userId, pc) =>
    set((s) => ({ peerConnections: { ...s.peerConnections, [userId]: pc } })),
  removePeerConnection: (userId) =>
    set((s) => {
      const { [userId]: _, ...rest } = s.peerConnections
      return { peerConnections: rest }
    }),
  setShowParticipantPanel: (show) => set({ showParticipantPanel: show }),
  setShowChatPanel: (show) => set({ showChatPanel: show }),
  setIsMiniPlayer: (mini) => set({ isMiniPlayer: mini }),
  bumpLocalMediaRev: () => set((s) => ({ localMediaRev: s.localMediaRev + 1 })),
  setCallStartTime: (t) => set({ callStartTime: t }),
  setActiveCallBanner: (roomId, count) =>
    set((s) => ({ activeCallBanner: { ...s.activeCallBanner, [roomId]: count } })),
  clearActiveCallBanner: (roomId) =>
    set((s) => {
      const { [roomId]: _, ...rest } = s.activeCallBanner
      return { activeCallBanner: rest }
    }),
  reset: () => {
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
    set({
      isInGroupCall: false,
      roomId: null,
      isVideo: false,
      transport: 'mesh',
      isScreenSharing: false,
      localStream: null,
      localScreenStream: null,
      remoteStreams: {},
      participants: {},
      peerConnections: {},
      showParticipantPanel: false,
      showChatPanel: false,
      isMiniPlayer: false,
      callStartTime: null,
    })
  },
}))

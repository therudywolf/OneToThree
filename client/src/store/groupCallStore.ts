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

export type GroupCallState = {
  // [CALL_STATE]
  isInGroupCall: boolean
  roomId: string | null
  isVideo: boolean

  // [STREAMS]
  localStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>

  // [PARTICIPANTS]
  participants: Record<string, GroupCallParticipant>

  // [PEER_CONNECTIONS]
  peerConnections: Record<string, RTCPeerConnection>

  // [UI_STATE]
  showParticipantPanel: boolean
  showChatPanel: boolean
  isMiniPlayer: boolean
  activeCallBanner: Record<string, number> // roomId -> participant count for rooms with active calls

  // [ACTIONS]
  setIsInGroupCall: (active: boolean) => void
  setRoomId: (roomId: string | null) => void
  setIsVideo: (isVideo: boolean) => void
  setLocalStream: (stream: MediaStream | null) => void
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
  setActiveCallBanner: (roomId: string, count: number) => void
  clearActiveCallBanner: (roomId: string) => void
  reset: () => void
}

export const useGroupCallStore = create<GroupCallState>((set) => ({
  isInGroupCall: false,
  roomId: null,
  isVideo: false,
  localStream: null,
  remoteStreams: {},
  participants: {},
  peerConnections: {},
  showParticipantPanel: false,
  showChatPanel: false,
  isMiniPlayer: false,
  activeCallBanner: {},

  setIsInGroupCall: (active) => set({ isInGroupCall: active }),
  setRoomId: (roomId) => set({ roomId }),
  setIsVideo: (isVideo) => set({ isVideo }),
  setLocalStream: (stream) => set({ localStream: stream }),
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
  setActiveCallBanner: (roomId, count) =>
    set((s) => ({ activeCallBanner: { ...s.activeCallBanner, [roomId]: count } })),
  clearActiveCallBanner: (roomId) =>
    set((s) => {
      const { [roomId]: _, ...rest } = s.activeCallBanner
      return { activeCallBanner: rest }
    }),
  reset: () =>
    set({
      isInGroupCall: false,
      roomId: null,
      isVideo: false,
      localStream: null,
      remoteStreams: {},
      participants: {},
      peerConnections: {},
      showParticipantPanel: false,
      showChatPanel: false,
      isMiniPlayer: false,
    }),
}))

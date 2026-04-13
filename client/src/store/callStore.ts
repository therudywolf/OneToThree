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

type CallProtocolState = {
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
}

const INITIAL_MEDIA_STATE = (): NodeMediaState => ({
  micMuted: false,
  cameraOff: false,
})

export const useCallStore = create<CallProtocolState>((set) => ({
  localFeed: null,
  remoteFeeds: {},
  nodeHints: {},
  signalLinks: {},
  isLinkActive: false,
  inboundRequest: null,

  // Управление локальным потоком (сенсоры устройства)
  setLocalFeed: (feed) => set({ localFeed: feed }),

  // Управление входящими фидами от стаи
  setRemoteFeed: (peerId, feed) =>
    set((state) => ({
      remoteFeeds: { ...state.remoteFeeds, [peerId]: feed },
    })),

  dropRemoteFeed: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.remoteFeeds
      return { remoteFeeds: rest }
    }),

  // Телеметрия удаленных узлов (статус микро/камер)
  updateNodeHint: (peerId, patch) =>
    set((state) => {
      const current = state.nodeHints[peerId] ?? INITIAL_MEDIA_STATE()
      return {
        nodeHints: {
          ...state.nodeHints,
          [peerId]: { ...current, ...patch },
        },
      }
    }),

  purgeNodeHint: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.nodeHints
      return { nodeHints: rest }
    }),

  // Сигнальные запросы на установку связи
  setInboundRequest: (request) => set({ inboundRequest: request }),

  setLinkStatus: (active) => set({ isLinkActive: active }),

  // Прямое управление дескрипторами WebRTC соединений
  registerSignalLink: (peerId, pc) =>
    set((state) => ({
      signalLinks: { ...state.signalLinks, [peerId]: pc },
    })),

  severSignalLink: (peerId) =>
    set((state) => {
      const { [peerId]: _, ...rest } = state.signalLinks
      return { signalLinks: rest }
    }),

  // Команда «ОТБОЙ» :: Полная стерилизация состояния
  resetProtocol: () =>
    set({
      localFeed: null,
      remoteFeeds: {},
      nodeHints: {},
      signalLinks: {},
      isLinkActive: false,
      inboundRequest: null,
    }),
}))
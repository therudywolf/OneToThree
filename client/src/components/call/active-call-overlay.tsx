'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  RefreshCw,
  Video,
  VideoOff,
  Minimize2,
  Grid3X3,
  Focus,
  WifiOff,
  Lock,
  Radio,
  ChevronDown,
  Camera,
  SwitchCamera,
  Headphones,
  HeadphoneOff,
  UserPlus,
  MessageSquare,
  Users,
  Activity,
  ExternalLink,
  MoreHorizontal,
  ArrowLeftRight,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { lookupUsers } from '@/lib/api/users'
import { isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS } from '@/lib/ios'
import { loadMediaPrefs, type CameraEffectPref } from '@/lib/media-devices'
import { warmupCameraEffects } from '@/lib/camera-effects'
import { useCallStore } from '@/store/callStore'
import type { QualityLevel, PeerConnectionType } from '@/store/callStore'
import { useSessionStore } from '@/store/sessionStore'
import { useThemeStore } from '@/store/themeStore'
import { PortalRoot } from '@/components/portal-root'
import { useTranslation, type TranslationKey } from '@/hooks/use-translation'
import { RelayToast } from '@/components/call/relay-toast'
import { CallTile } from '@/components/call/call-tile'
import { CallDebugPanel } from '@/components/call/call-debug-panel'
import { CallParticipantsPanel, type ParticipantRow } from '@/components/call/call-participants-panel'
import { isDocPipSupported, openDocPipWindow } from '@/lib/call-pip'

type Props = {
  onEndCall: () => void
  onToggleMute: () => void
  /** Toggle the camera on/off (lazy getUserMedia on first opt-in). */
  onToggleCamera: () => void
  /** Whether a camera track currently exists and is enabled. */
  isCameraOn: boolean
  /** Enumerate videoinput devices for the desktop camera selector. */
  onListCameras: () => Promise<MediaDeviceInfo[]>
  /** Desktop: switch to a specific camera device by id. */
  onSelectCamera: (deviceId: string) => void
  /** Mobile: flip between front/back camera (facingMode). */
  onFlipCamera: () => void
  isScreenSharing: boolean
  onToggleScreenShare: () => void
  /** Screen-share audio: present in the current share, its local mute, toggle. */
  hasScreenAudio?: boolean
  isScreenAudioMuted?: boolean
  onToggleScreenAudio?: () => void
  /** Peer's display name — shown as the remote tile label instead of a hex id (#12). */
  peerName?: string
  /** Direct-chat contact ids that can be pulled into this call (1:1→group, #4). */
  promoteCandidateIds?: string[]
  /** Promote this 1:1 call to a group call with the given invitee (#4). */
  onPromote?: (inviteeUserId: string) => Promise<void>
  onSetQuality: (level: QualityLevel) => void
  /** Switch the camera background effect (none/blur/image) live. */
  onSetCameraEffect?: (kind: CameraEffectPref) => void
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function getQualityDotColor(quality: { rtt: number | null; outgoingBitrate: number | null; poor: boolean } | null): 'green' | 'yellow' | 'red' {
  if (!quality) return 'green'
  if (quality.poor) return 'red'
  if (quality.rtt != null && quality.rtt > 0.15) return 'yellow'
  if (quality.outgoingBitrate != null && quality.outgoingBitrate < 300_000) return 'yellow'
  return 'green'
}

// Solid, legible, semantically-correct status colors (issue #12).
const DOT_COLORS = {
  green: 'bg-[#22c55e]',
  yellow: 'bg-[#f59e0b]',
  red: 'bg-neon-red',
} as const

function getGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-1 md:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 md:grid-cols-3'
  return 'grid-cols-3 md:grid-cols-4'
}

const QUALITY_OPTIONS: QualityLevel[] = ['auto', '720p', '480p', '360p', 'audio_only']

function qualityLabel(level: QualityLevel, t: (key: TranslationKey) => string): string {
  switch (level) {
    case 'auto': return t('call.qualityAuto')
    case '720p': return '720p'
    case '480p': return '480p'
    case '360p': return '360p'
    case 'audio_only': return t('call.qualityAudioOnly')
  }
}

function connectionTypeLabel(type: PeerConnectionType, t: (key: TranslationKey) => string): { label: string; icon: 'lock' | 'radio' } {
  if (type === 'relay') return { label: t('call.connRelay'), icon: 'radio' }
  return { label: t('call.connP2P'), icon: 'lock' }
}

const LAYOUT_STORAGE_KEY = 'p13_call_layout'
const LOCAL_PIP_STORAGE_KEY = 'p13_call_local_pip'

type LocalPipRect = { x: number | null; y: number | null; w: number }

function loadLocalPipRect(): LocalPipRect {
  if (typeof window === 'undefined') return { x: null, y: null, w: 224 }
  try {
    const raw = window.localStorage.getItem(LOCAL_PIP_STORAGE_KEY)
    if (!raw) return { x: null, y: null, w: 224 }
    const v = JSON.parse(raw) as LocalPipRect
    return {
      x: typeof v.x === 'number' ? v.x : null,
      y: typeof v.y === 'number' ? v.y : null,
      w: typeof v.w === 'number' ? Math.min(480, Math.max(140, v.w)) : 224,
    }
  } catch {
    return { x: null, y: null, w: 224 }
  }
}

/** Simple always-live video element for the Document-PiP popout. */
function PipVideo({ stream, mirrored }: { stream: MediaStream | null; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stream) {
      if (el.srcObject !== stream) el.srcObject = stream
      void el.play().catch(() => {})
    } else {
      el.srcObject = null
    }
  }, [stream])
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`h-full w-full object-contain ${mirrored ? 'scale-x-[-1]' : ''}`}
    />
  )
}

// --- MAIN OVERLAY ---
export function ActiveCallOverlay({
  onEndCall,
  onToggleMute,
  onToggleCamera,
  isCameraOn,
  onListCameras,
  onSelectCamera,
  onFlipCamera,
  isScreenSharing,
  onToggleScreenShare,
  hasScreenAudio = false,
  isScreenAudioMuted = false,
  onToggleScreenAudio,
  onSetQuality,
  peerName,
  promoteCandidateIds,
  onPromote,
  onSetCameraEffect,
}: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const isCalling = useCallStore((s) => s.isCalling)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)
  const remotePeerMedia = useCallStore((s) => s.remotePeerMedia)
  const isReconnecting = useCallStore((s) => s.isReconnecting)
  const isConnectionLost = useCallStore((s) => s.isConnectionLost)
  const connectionQuality = useCallStore((s) => s.connectionQuality)
  const peerConnectionTypes = useCallStore((s) => s.peerConnectionTypes)
  const peerConnections = useCallStore((s) => s.peerConnections)
  const qualityLevel = useCallStore((s) => s.qualityLevel)
  const callStartTime = useCallStore((s) => s.callStartTime)
  const callChatId = useCallStore((s) => s.callChatId)

  const isMiniPlayer = useCallStore((s) => s.isMiniPlayer)
  const setMiniPlayer = useCallStore((s) => s.setMiniPlayer)
  const deafened = useCallStore((s) => s.deafened)
  const setDeafened = useCallStore((s) => s.setDeafened)
  const sidePanel = useCallStore((s) => s.sidePanel)
  const setSidePanel = useCallStore((s) => s.setSidePanel)
  const chatOpen = useCallStore((s) => s.chatOpen)
  const setChatOpen = useCallStore((s) => s.setChatOpen)
  const localMediaRev = useCallStore((s) => s.localMediaRev)

  const [tick, setTick] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [screenShareAllowed, setScreenShareAllowed] = useState(true)
  const [isMobileDevice, setIsMobileDevice] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'spotlight'>(() => {
    if (typeof window === 'undefined') return 'spotlight'
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) === 'grid' ? 'grid' : 'spotlight'
  })
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [showControls, setShowControls] = useState(true)
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  const [showCameraMenu, setShowCameraMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  // 1:1 → group promotion picker (#4)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [addCandidates, setAddCandidates] = useState<Array<{ id: string; username: string }>>([])
  const [promoteBusy, setPromoteBusy] = useState(false)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [remoteNames, setRemoteNames] = useState<Record<string, string>>({})
  // Local floating self-view (spotlight mode, 2 participants): drag + resize.
  // Positioned ABSOLUTE inside the tiles area (not the viewport) so it can
  // never cover the side chat / panels.
  const [localPip, setLocalPip] = useState<LocalPipRect>(() => loadLocalPipRect())
  const localPipDragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; baseX: number; baseY: number; baseW: number } | null>(null)
  const localPipElRef = useRef<HTMLDivElement | null>(null)
  const tilesAreaRef = useRef<HTMLDivElement | null>(null)
  // Document-PiP popout window (null = not popped out).
  const [pipWindow, setPipWindow] = useState<Window | null>(null)

  useEffect(() => {
    if (!showAddMenu || !promoteCandidateIds?.length) return
    let cancelled = false
    void lookupUsers(promoteCandidateIds)
      .then((rows) => {
        if (cancelled) return
        setAddCandidates(rows.map((r) => ({ id: r.id, username: r.username })))
      })
      .catch(() => { if (!cancelled) setAddCandidates([]) })
    return () => { cancelled = true }
  }, [showAddMenu, promoteCandidateIds])

  useEffect(() => {
    setScreenShareAllowed(!isAndroidMobile())
    setIsMobileDevice(isAndroidMobile() || isIOSOrIPadOS())
  }, [])

  // Viewport class for the chat-panel shrink (side chat only makes sense wide).
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)')
    const apply = () => setIsNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // Refresh the desktop camera list whenever the selector is opened.
  useEffect(() => {
    if (!showCameraMenu) return
    let cancelled = false
    void onListCameras().then((list) => {
      if (!cancelled) setCameras(list)
    })
    return () => { cancelled = true }
  }, [showCameraMenu, onListCameras])

  // Cleanup: end call if the overlay unmounts while still calling (but not when minimized)
  useEffect(() => {
    return () => {
      const state = useCallStore.getState()
      if (state.isCalling && !state.isMiniPlayer) {
        onEndCall()
      }
    }
  }, [onEndCall])

  useEffect(() => {
    let timeout: NodeJS.Timeout
    const handleMouseMove = () => {
      setShowControls(true)
      clearTimeout(timeout)
      timeout = setTimeout(() => setShowControls(false), 3500)
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      clearTimeout(timeout)
    }
  }, [])

  // Warm the segmentation runtime while the call UI is up, so the first
  // camera-on with a background effect doesn't stall on wasm/model load.
  useEffect(() => {
    if (loadMediaPrefs().camEffect !== 'none') warmupCameraEffects()
  }, [])

  // Hotkeys: Ctrl+Shift+M mute, Ctrl+Shift+D deafen. Ignored while typing
  // (side chat composer, menus with inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) return
      const key = e.key.toUpperCase()
      if (key === 'M') {
        e.preventDefault()
        onToggleMute()
        setTick((t_) => t_ + 1)
      } else if (key === 'D') {
        e.preventDefault()
        setDeafened(!useCallStore.getState().deafened)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleMute, setDeafened])

  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams])
  const tileCount = 1 + remoteEntries.length

  // Resolve display names for every remote (a promoted mesh call can carry
  // several peers; `peerName` only covers the classic 1:1 case). Requested ids
  // are remembered so an id the lookup can't resolve is not refetched in a loop.
  const requestedNamesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ids = remoteEntries
      .map(([id]) => id)
      .filter((id) => !remoteNames[id] && !requestedNamesRef.current.has(id))
    if (ids.length === 0) return
    ids.forEach((id) => requestedNamesRef.current.add(id))
    let cancelled = false
    void lookupUsers(ids)
      .then((rows) => {
        if (cancelled) return
        setRemoteNames((prev) => {
          const next = { ...prev }
          for (const r of rows) next[r.id] = r.username
          return next
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [remoteEntries, remoteNames])

  const nameFor = useCallback(
    (id: string) => remoteNames[id] || peerName || id.slice(0, 8),
    [remoteNames, peerName]
  )

  useEffect(() => {
    if (!isCalling || !localStream || !callStartTime) {
      setElapsed(0)
      return
    }
    const id = window.setInterval(() => {
      setElapsed(Date.now() - callStartTime)
    }, 500)
    return () => window.clearInterval(id)
  }, [isCalling, localStream, callStartTime])

  // Auto-spotlight a remote that STARTS screen sharing (unless the user pinned
  // something themselves).
  const prevSharingRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const sharing = new Set(
      Object.entries(remotePeerMedia)
        .filter(([, m]) => m.screenSharing)
        .map(([id]) => id)
    )
    const started = Array.from(sharing).find((id) => !prevSharingRef.current.has(id))
    prevSharingRef.current = sharing
    if (started && remoteStreams[started]) {
      setLayout('spotlight')
      setPinnedId((prev) => prev ?? null) // keep manual pin; auto-pin handles the rest
    }
  }, [remotePeerMedia, remoteStreams])

  // Drop a manual pin when that participant leaves.
  useEffect(() => {
    if (pinnedId && pinnedId !== 'local' && !remoteStreams[pinnedId]) {
      setPinnedId(null)
    }
  }, [pinnedId, remoteStreams])

  const audioMuted = localStream?.getAudioTracks().some((t_) => !t_.enabled) ?? false
  // WebSocket PCM relay call (no RTCPeerConnection): audio only — every video
  // control is hidden exactly like before.
  const isAudioRelay = Object.keys(peerConnections).length === 0

  const setLayoutPersist = useCallback((next: 'grid' | 'spotlight') => {
    setLayout(next)
    try { window.localStorage.setItem(LAYOUT_STORAGE_KEY, next) } catch { /* quota */ }
  }, [])

  // Spotlight target: manual pin → remote screen share → first remote → local.
  const autoSpotlightId = useMemo(() => {
    const sharing = remoteEntries.find(([id]) => remotePeerMedia[id]?.screenSharing)
    if (sharing) return sharing[0]
    return remoteEntries[0]?.[0] ?? 'local'
  }, [remoteEntries, remotePeerMedia])
  const spotlightId = pinnedId ?? autoSpotlightId

  const pinToggle = useCallback((id: string) => {
    setPinnedId((prev) => (prev === id ? null : id))
    setLayout('spotlight')
  }, [])

  // --- Local floating self-view drag/resize (pointer events) ---
  // Coordinates are relative to the tiles area container, clamped inside it.
  const onLocalPipPointerDown = useCallback((e: React.PointerEvent, mode: 'move' | 'resize') => {
    const el = localPipElRef.current
    const area = tilesAreaRef.current
    if (!el || !area) return
    e.preventDefault()
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    const areaRect = area.getBoundingClientRect()
    localPipDragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect.left - areaRect.left,
      baseY: rect.top - areaRect.top,
      baseW: rect.width,
    }
    const onMove = (ev: PointerEvent) => {
      const drag = localPipDragRef.current
      const areaEl = tilesAreaRef.current
      if (!drag || !areaEl) return
      if (drag.mode === 'move') {
        const w = localPipElRef.current?.offsetWidth ?? drag.baseW
        const h = localPipElRef.current?.offsetHeight ?? (drag.baseW * 9) / 16
        const x = Math.min(areaEl.clientWidth - w - 4, Math.max(4, drag.baseX + ev.clientX - drag.startX))
        const y = Math.min(areaEl.clientHeight - h - 4, Math.max(4, drag.baseY + ev.clientY - drag.startY))
        setLocalPip((prev) => ({ ...prev, x, y }))
      } else {
        const maxW = Math.max(160, Math.min(520, (tilesAreaRef.current?.clientWidth ?? 520) - 24))
        const w = Math.min(maxW, Math.max(140, drag.baseW + (ev.clientX - drag.startX)))
        setLocalPip((prev) => ({ ...prev, w }))
      }
    }
    const onUp = () => {
      localPipDragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLocalPip((prev) => {
        try { window.localStorage.setItem(LOCAL_PIP_STORAGE_KEY, JSON.stringify(prev)) } catch { /* quota */ }
        return prev
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // --- Document PiP popout ---
  const openPopout = useCallback(async () => {
    const win = await openDocPipWindow({ width: 420, height: 320 })
    if (!win) return
    setPipWindow(win)
    win.addEventListener('pagehide', () => setPipWindow(null))
  }, [])

  useEffect(() => {
    // Close the popout with the call.
    if (!isCalling && pipWindow) {
      try { pipWindow.close() } catch { /* closed */ }
      setPipWindow(null)
    }
  }, [isCalling, pipWindow])

  const openInCallChat = useCallback(() => {
    // Focus the call's chat first, so the panel shows the right conversation.
    if (callChatId) useSessionStore.getState().setActiveChatId(callChatId)
    if (isNarrow) {
      // Mobile: the "chat" is the real app behind the call — minimize to it.
      setMiniPlayer(true)
      return
    }
    setChatOpen(!chatOpen)
  }, [callChatId, isNarrow, chatOpen, setChatOpen, setMiniPlayer])

  if (!isCalling || !localStream) return null

  // Popout content survives minimize: the overlay hides, the PiP window stays.
  const popoutPortal = pipWindow
    ? createPortal(
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', color: '#eee', fontFamily: 'monospace' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <PipVideo
              stream={
                spotlightId !== 'local'
                  ? remoteStreams[spotlightId] ?? remoteEntries[0]?.[1] ?? null
                  : localStream
              }
              mirrored={spotlightId === 'local' && !isScreenSharing}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 }}>
            <button
              onClick={() => { onToggleMute(); setTick((v) => v + 1) }}
              style={{ background: audioMuted ? '#7f1d1d' : '#222', color: '#eee', border: '1px solid #444', padding: '8px 14px', cursor: 'pointer' }}
            >
              {audioMuted ? t('call.unmute') : t('call.mute')}
            </button>
            <button
              onClick={() => setDeafened(!deafened)}
              style={{ background: deafened ? '#7f1d1d' : '#222', color: '#eee', border: '1px solid #444', padding: '8px 14px', cursor: 'pointer' }}
            >
              {deafened ? t('call.undeafen') : t('call.deafen')}
            </button>
            <button
              onClick={onEndCall}
              style={{ background: '#dc2626', color: '#fff', border: '1px solid #dc2626', padding: '8px 14px', cursor: 'pointer' }}
            >
              {t('call.endCall')}
            </button>
          </div>
        </div>,
        pipWindow.document.body
      )
    : null

  if (isMiniPlayer) return popoutPortal

  const chatShrink = chatOpen && !isNarrow
  const sidePanelOpen = sidePanel !== 'none'

  // Tiles other than the spotlight (local included). With exactly two
  // participants the local tile floats instead of sitting in a strip.
  const stripTiles: Array<{ id: string; stream: MediaStream | null }> = []
  if (layout === 'spotlight') {
    if (spotlightId !== 'local') stripTiles.push({ id: 'local', stream: localStream })
    for (const [id, stream] of remoteEntries) {
      if (id !== spotlightId) stripTiles.push({ id, stream })
    }
  }
  const useFloatingSelf = layout === 'spotlight' && spotlightId !== 'local' && stripTiles.length === 1
  const visibleStrip = useFloatingSelf ? [] : stripTiles

  const participantRows: ParticipantRow[] = [
    {
      userId: 'local',
      label: t('call.you'),
      isLocal: true,
      micMuted: audioMuted,
      camOff: !isCameraOn && !isScreenSharing,
      screenSharing: isScreenSharing,
    },
    ...remoteEntries.map(([id]) => ({
      userId: id,
      label: nameFor(id),
      micMuted: remotePeerMedia[id]?.micMuted,
      camOff: remotePeerMedia[id]?.cameraOff,
      screenSharing: remotePeerMedia[id]?.screenSharing,
      connectionType: peerConnectionTypes[id],
    })),
  ]

  const controlBtn = (active: boolean, danger = false) =>
    isMd3
      ? `h-12 w-12 rounded-full ${
          danger
            ? 'bg-[var(--error-container,color-mix(in_srgb,var(--danger)_24%,var(--surface)))] text-[var(--on-error-container,var(--danger))]'
            : active
              ? 'bg-[var(--primary-container,color-mix(in_srgb,var(--primary)_24%,var(--surface)))] text-[var(--on-primary-container,var(--primary))]'
              : 'bg-[var(--surface-variant)] text-[var(--on-surface-variant)] hover:bg-[var(--surface-variant)]/80'
        }`
      : `h-12 w-12 md:w-14 border-r border-border-strong ${
          danger
            ? 'bg-danger/30 text-neon-red'
            : active
              ? 'bg-neon-cyan/10 text-neon-cyan'
              : 'text-text-muted hover:text-text-primary hover:bg-surface/5'
        }`

  return (
    <PortalRoot>
      <RelayToast />
      {popoutPortal}
      <div
        className={`fixed inset-y-0 left-0 z-[200] flex flex-col ${isRetro ? 'p13-classic-overlay font-["Tahoma"]' : 'bg-void'} ${isMd3 ? '' : 'font-mono'}`}
        style={{ right: chatShrink ? 'min(400px, 45vw)' : 0 }}
        role="dialog"
      >
        {/* HEADER BAR */}
        <div className={`flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] ${isRetro ? 'p13-titlebar' : 'border-border-strong bg-void/50 backdrop-blur-md'}`}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isMd3 ? 'bg-[var(--primary)]' : 'bg-neon-cyan'} opacity-75`}></span>
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isMd3 ? 'bg-[var(--primary)]' : 'bg-neon-cyan'}`}></span>
            </span>
            {isMd3 ? (
              <p className="truncate text-sm font-medium text-[var(--on-surface)]">
                {peerName || t('call.activePeer')} · {tileCount}
              </p>
            ) : (
              <p className="truncate text-[10px] uppercase tracking-[0.2em] text-text-muted">
                SYS.LINK // <span className="text-text-primary">{peerName || `NODES: ${tileCount}`}</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isScreenSharing && (
              <span className="hidden items-center gap-1.5 border border-neon-cyan/50 bg-neon-cyan/10 px-2 py-0.5 md:flex">
                <Monitor className="h-3 w-3 text-neon-cyan" />
                <span className={`${isMd3 ? '' : 'font-mono '}text-[9px] uppercase tracking-wider text-neon-cyan`}>{t('call.screenSharing')}</span>
              </span>
            )}

            {Object.entries(peerConnectionTypes).map(([peerId, connType]) => {
              if (connType === 'unknown') return null
              const info = connectionTypeLabel(connType, t)
              return (
                <span
                  key={peerId}
                  className={`hidden items-center gap-1 border px-2 py-0.5 md:flex ${
                    connType === 'p2p'
                      ? 'border-success/40 bg-success/20'
                      : 'border-accent-2/40 bg-accent-2/15'
                  }`}
                  title={connType === 'relay' ? t('call.relayTooltip') : t('call.p2pTooltip')}
                >
                  {info.icon === 'lock'
                    ? <Lock className="h-3 w-3 text-success" />
                    : <Radio className="h-3 w-3 text-accent-2" />
                  }
                  <span className={`${isMd3 ? '' : 'font-mono '}text-[9px] uppercase tracking-wider ${
                    connType === 'p2p' ? 'text-success' : 'text-accent-2'
                  }`}>{info.label}</span>
                </span>
              )
            })}

            <span className={`inline-block h-2 w-2 rounded-full ${DOT_COLORS[getQualityDotColor(connectionQuality)]}`} title={t('call.quality')} />

            {isConnectionLost && (
              <span className="flex items-center gap-1.5 border border-neon-red/50 bg-danger/30 px-2 py-0.5">
                <WifiOff className="h-3 w-3 text-neon-red" />
                <span className={`${isMd3 ? '' : 'font-mono '}text-[9px] uppercase tracking-wider text-neon-red`}>{t('call.connectionLost')}</span>
              </span>
            )}
            {isReconnecting && !isConnectionLost && (
              <span className="flex animate-pulse items-center gap-1.5 border border-accent-2/40 bg-accent-2/15 px-2 py-0.5">
                <RefreshCw className="h-3 w-3 animate-spin text-accent-2" />
                <span className={`${isMd3 ? '' : 'font-mono '}text-[9px] uppercase tracking-wider text-accent-2`}>{t('call.reconnecting')}</span>
              </span>
            )}
            <p className="text-xs tracking-wider text-neon-cyan/70">
              [{formatDuration(elapsed)}]
            </p>
            {isDocPipSupported() ? (
              <button
                type="button"
                onClick={() => { if (pipWindow) { pipWindow.close(); setPipWindow(null) } else void openPopout() }}
                className={`flex h-8 w-8 items-center justify-center border transition-colors ${
                  pipWindow
                    ? 'border-neon-cyan/60 text-neon-cyan'
                    : 'border-border-strong text-text-muted hover:border-neon-cyan/60 hover:text-neon-cyan'
                }`}
                title={t('call.popOut')}
                aria-label={t('call.popOut')}
              >
                <ExternalLink className="h-4 w-4" strokeWidth={1.5} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setMiniPlayer(true)}
              className="flex h-8 w-8 items-center justify-center border border-border-strong text-text-muted transition-colors hover:border-neon-cyan/60 hover:text-neon-cyan"
              title={t('call.minimize')}
              aria-label={t('call.minimize')}
            >
              <Minimize2 className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* BODY: tiles + optional side panel */}
        <div className="flex min-h-0 flex-1">
          <div ref={tilesAreaRef} className="relative min-w-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-elevated to-void p-2">
            {layout === 'spotlight' ? (
              <div className="flex h-full flex-col gap-2">
                <div className="min-h-0 flex-1">
                  {spotlightId === 'local' ? (
                    <CallTile
                      peerId="local"
                      stream={localStream}
                      label={t('call.you')}
                      isLocal
                      micMuted={audioMuted}
                      camOff={!isCameraOn && !isScreenSharing}
                      screenSharing={isScreenSharing}
                      pinned={pinnedId === 'local'}
                      onPinToggle={() => pinToggle('local')}
                      mediaRev={localMediaRev}
                    />
                  ) : (
                    <CallTile
                      peerId={spotlightId}
                      stream={remoteStreams[spotlightId] ?? null}
                      label={nameFor(spotlightId)}
                      micMuted={remotePeerMedia[spotlightId]?.micMuted}
                      camOff={remotePeerMedia[spotlightId]?.cameraOff}
                      screenSharing={remotePeerMedia[spotlightId]?.screenSharing}
                      connectionType={peerConnectionTypes[spotlightId]}
                      pinned={pinnedId === spotlightId}
                      onPinToggle={() => pinToggle(spotlightId)}
                    />
                  )}
                </div>
                {visibleStrip.length > 0 && (
                  <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                    {visibleStrip.map(({ id, stream }) => (
                      <div key={id} className="h-24 w-40 flex-shrink-0 md:h-28 md:w-48">
                        {id === 'local' ? (
                          <CallTile
                            peerId="local"
                            stream={localStream}
                            label={t('call.you')}
                            isLocal
                            micMuted={audioMuted}
                            camOff={!isCameraOn && !isScreenSharing}
                            screenSharing={isScreenSharing}
                            onPinToggle={() => pinToggle('local')}
                            showPin={false}
                            mediaRev={localMediaRev}
                          />
                        ) : (
                          <CallTile
                            peerId={id}
                            stream={stream}
                            label={nameFor(id)}
                            micMuted={remotePeerMedia[id]?.micMuted}
                            camOff={remotePeerMedia[id]?.cameraOff}
                            screenSharing={remotePeerMedia[id]?.screenSharing}
                            connectionType={peerConnectionTypes[id]}
                            onPinToggle={() => pinToggle(id)}
                            showPin={false}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className={`grid h-full auto-rows-fr gap-2 ${getGridClass(tileCount)}`}>
                <CallTile
                  peerId="local"
                  stream={localStream}
                  label={t('call.you')}
                  isLocal
                  micMuted={audioMuted}
                  camOff={!isCameraOn && !isScreenSharing}
                  screenSharing={isScreenSharing}
                  onPinToggle={() => pinToggle('local')}
                  mediaRev={localMediaRev}
                />
                {remoteEntries.map(([id, stream]) => (
                  <CallTile
                    key={id}
                    peerId={id}
                    stream={stream}
                    label={nameFor(id)}
                    micMuted={remotePeerMedia[id]?.micMuted}
                    camOff={remotePeerMedia[id]?.cameraOff}
                    screenSharing={remotePeerMedia[id]?.screenSharing}
                    connectionType={peerConnectionTypes[id]}
                    onPinToggle={() => pinToggle(id)}
                  />
                ))}
              </div>
            )}

            {/* Floating draggable/resizable self-view (classic 1:1 spotlight) */}
            {useFloatingSelf && (
              <div
                ref={localPipElRef}
                className="absolute z-30 cursor-grab touch-none shadow-2xl active:cursor-grabbing"
                style={{
                  width: `${localPip.w}px`,
                  left: localPip.x !== null ? `${localPip.x}px` : undefined,
                  top: localPip.y !== null ? `${localPip.y}px` : undefined,
                  right: localPip.x === null ? '1rem' : undefined,
                  bottom: localPip.y === null ? '6.5rem' : undefined,
                  aspectRatio: '16/9',
                }}
                onPointerDown={(e) => onLocalPipPointerDown(e, 'move')}
              >
                <CallTile
                  peerId="local"
                  stream={localStream}
                  label={t('call.you')}
                  isLocal
                  micMuted={audioMuted}
                  camOff={!isCameraOn && !isScreenSharing}
                  screenSharing={isScreenSharing}
                  onPinToggle={() => pinToggle('local')}
                  showPin={false}
                  mediaRev={localMediaRev}
                />
                {/* resize handle */}
                <div
                  className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-nwse-resize"
                  onPointerDown={(e) => onLocalPipPointerDown(e, 'resize')}
                  title={t('call.resize')}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 rotate-45 text-text-muted" />
                </div>
              </div>
            )}
          </div>

          {/* SIDE PANEL (participants / debug) */}
          {sidePanelOpen && (
            <aside className="w-[300px] max-w-[85vw] shrink-0 border-l border-border-strong">
              {sidePanel === 'participants' ? (
                <CallParticipantsPanel
                  rows={participantRows}
                  onClose={() => setSidePanel('none')}
                />
              ) : (
                <CallDebugPanel
                  peers={peerConnections}
                  labels={Object.fromEntries(remoteEntries.map(([id]) => [id, nameFor(id)]))}
                  extraLines={isAudioRelay ? [t('call.debugRelayNote')] : []}
                  onClose={() => setSidePanel('none')}
                />
              )}
            </aside>
          )}
        </div>

        {/* CONTROLS */}
        <div className={`absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center shadow-2xl transition-all duration-300 ${showControls ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'} ${
          isMd3
            ? 'gap-2 rounded-[28px] bg-[var(--surface-container-high,var(--surface-elevated))]/95 px-3 py-2'
            : isRetro
              ? 'p13-classic-menu gap-1 px-2 py-2'
              : 'border border-border-strong bg-void/90'
        }`}>

          <button
            onClick={() => { onToggleMute(); setTick(t_ => t_ + 1); }}
            className={`flex items-center justify-center transition-colors ${controlBtn(false, audioMuted)}`}
            title={`${audioMuted ? t('call.unmute') : t('call.mute')} (Ctrl+Shift+M)`}
            aria-pressed={audioMuted}
          >
            {audioMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          <button
            onClick={() => setDeafened(!deafened)}
            className={`flex items-center justify-center transition-colors ${controlBtn(false, deafened)}`}
            title={`${deafened ? t('call.undeafen') : t('call.deafen')} (Ctrl+Shift+D)`}
            aria-label={deafened ? t('call.undeafen') : t('call.deafen')}
            aria-pressed={deafened}
          >
            {deafened ? <HeadphoneOff className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
          </button>

          {/* Camera on/off — reflects the *camera* track state, never the screen. */}
          <button
            onClick={() => { onToggleCamera(); setShowCameraMenu(false); setTick(t_ => t_ + 1); }}
            disabled={isAudioRelay}
            className={`flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${controlBtn(isCameraOn)}`}
            title={isCameraOn ? t('call.videoOff') : t('call.videoOn')}
            aria-label={isCameraOn ? t('call.videoOff') : t('call.videoOn')}
            aria-pressed={isCameraOn}
          >
            {isCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>

          {isCameraOn && !isScreenSharing && !isAudioRelay && (
            isMobileDevice ? (
              <button
                onClick={() => { onFlipCamera(); setTick(t_ => t_ + 1); }}
                className={`flex items-center justify-center transition-colors ${controlBtn(false)}`}
                title={t('call.flipCamera')}
                aria-label={t('call.flipCamera')}
              >
                <SwitchCamera className="h-4 w-4" />
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={() => { setShowCameraMenu((prev) => !prev); setShowMoreMenu(false); setShowQualityMenu(false) }}
                  className={`flex items-center justify-center transition-colors ${controlBtn(showCameraMenu)}`}
                  title={t('call.selectCamera')}
                  aria-label={t('call.selectCamera')}
                  aria-expanded={showCameraMenu}
                >
                  <Camera className="h-4 w-4" />
                  <ChevronDown className="ml-0.5 h-3 w-3" />
                </button>
                {showCameraMenu && (
                  <div className={`absolute bottom-14 left-1/2 z-50 min-w-[220px] max-w-[280px] -translate-x-1/2 shadow-2xl ${
                    isMd3
                      ? 'overflow-hidden rounded-2xl bg-[var(--surface-container-high,var(--surface-elevated))]'
                      : 'border border-border-strong bg-void/95 backdrop-blur-xl'
                  }`}>
                    {cameras.length === 0 ? (
                      <p className={`px-4 py-2.5 text-left ${
                        isMd3 ? 'text-sm text-[var(--on-surface)]/60' : 'font-mono text-[11px] uppercase tracking-wider text-text-muted/70'
                      }`}>
                        {t('call.noCameras')}
                      </p>
                    ) : (
                      cameras.map((cam, idx) => (
                        <button
                          key={cam.deviceId || idx}
                          onClick={() => { onSelectCamera(cam.deviceId); setShowCameraMenu(false); setTick(t_ => t_ + 1); }}
                          className={`w-full truncate px-4 py-2.5 text-left transition-colors ${
                            isMd3
                              ? 'text-sm text-[var(--on-surface)] hover:bg-[var(--surface-variant)]'
                              : 'font-mono text-[11px] uppercase tracking-wider text-text-muted hover:bg-surface/5 hover:text-text-primary'
                          }`}
                          title={cam.label || `${t('call.camera')} ${idx + 1}`}
                        >
                          {cam.label || `${t('call.camera')} ${idx + 1}`}
                        </button>
                      ))
                    )}
                    {/* Background effect (blur / image) — live switch. */}
                    {onSetCameraEffect ? (
                      <>
                        <p className={`border-t px-4 pb-1 pt-2 text-left ${
                          isMd3
                            ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-[11px] text-[var(--on-surface)]/60'
                            : 'border-border-strong/60 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted/70'
                        }`}>
                          {t('call.background')}
                        </p>
                        {(['none', 'blur', 'image'] as const).map((kind) => {
                          const active = loadMediaPrefs().camEffect === kind
                          const label =
                            kind === 'none'
                              ? t('call.backgroundNone')
                              : kind === 'blur'
                                ? t('call.backgroundBlur')
                                : t('call.backgroundImage')
                          return (
                            <button
                              key={kind}
                              onClick={() => { onSetCameraEffect(kind); setShowCameraMenu(false); setTick(t_ => t_ + 1); }}
                              className={`w-full truncate px-4 py-2 text-left transition-colors ${
                                isMd3
                                  ? `text-sm ${active ? 'bg-[var(--primary-container,color-mix(in_srgb,var(--primary)_24%,var(--surface)))] text-[var(--on-primary-container,var(--primary))]' : 'text-[var(--on-surface)] hover:bg-[var(--surface-variant)]'}`
                                  : `font-mono text-[11px] uppercase tracking-wider ${active ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'}`
                              }`}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )
          )}

          {screenShareAllowed && !isAudioRelay && (
            <button
              onClick={() => { onToggleScreenShare(); setShowCameraMenu(false); setTick(t_ => t_ + 1); }}
              className={`hidden items-center justify-center transition-colors md:flex ${controlBtn(isScreenSharing)}`}
              title={isScreenSharing ? t('call.stopScreenShare') : t('call.startScreenShare')}
              aria-label={isScreenSharing ? t('call.stopScreenShare') : t('call.startScreenShare')}
              aria-pressed={isScreenSharing}
            >
              {isScreenSharing ? <MonitorOff className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
            </button>
          )}

          {/* Screen-share AUDIO mute — visible only while sharing with audio. */}
          {isScreenSharing && hasScreenAudio && onToggleScreenAudio && (
            <button
              onClick={() => { onToggleScreenAudio(); setTick(t_ => t_ + 1); }}
              className={`hidden items-center justify-center transition-colors md:flex ${controlBtn(false, isScreenAudioMuted)}`}
              title={isScreenAudioMuted ? t('call.screenAudioOn') : t('call.screenAudioOff')}
              aria-label={isScreenAudioMuted ? t('call.screenAudioOn') : t('call.screenAudioOff')}
              aria-pressed={isScreenAudioMuted}
            >
              {isScreenAudioMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          )}

          {/* In-call chat (Discord-style side panel; minimizes on mobile) */}
          <button
            onClick={openInCallChat}
            className={`flex items-center justify-center transition-colors ${controlBtn(chatOpen && !isNarrow)}`}
            title={t('call.openChat')}
            aria-label={t('call.openChat')}
            aria-pressed={chatOpen && !isNarrow}
          >
            <MessageSquare className="h-4 w-4" />
          </button>

          {/* Participants */}
          <button
            onClick={() => setSidePanel(sidePanel === 'participants' ? 'none' : 'participants')}
            className={`flex items-center justify-center transition-colors ${controlBtn(sidePanel === 'participants')}`}
            title={t('groupCall.participants')}
            aria-label={t('groupCall.participants')}
            aria-pressed={sidePanel === 'participants'}
          >
            <div className="relative">
              <Users className="h-4 w-4" />
              <span className={`absolute -right-2 -top-1.5 text-[8px] ${isMd3 ? '' : 'font-mono '}text-neon-cyan`}>
                {tileCount}
              </span>
            </div>
          </button>

          {/* Layout toggle */}
          <button
            onClick={() => setLayoutPersist(layout === 'grid' ? 'spotlight' : 'grid')}
            className={`hidden items-center justify-center transition-colors md:flex ${controlBtn(false)}`}
            title={t('call.toggleLayout')}
            aria-label={t('call.toggleLayout')}
          >
            {layout === 'grid' ? <Focus className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
          </button>

          {/* More menu: quality, debug, add-user */}
          <div className="relative">
            <button
              onClick={() => { setShowMoreMenu((v) => !v); setShowQualityMenu(false); setShowCameraMenu(false); setShowAddMenu(false) }}
              className={`flex items-center justify-center transition-colors ${controlBtn(showMoreMenu || sidePanel === 'debug')}`}
              title={t('call.more')}
              aria-label={t('call.more')}
              aria-expanded={showMoreMenu}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {showMoreMenu && (
              <div className={`absolute bottom-14 left-1/2 z-50 min-w-[200px] -translate-x-1/2 shadow-2xl ${
                isMd3
                  ? 'overflow-hidden rounded-2xl bg-[var(--surface-container-high,var(--surface-elevated))]'
                  : 'border border-border-strong bg-void/95 backdrop-blur-xl'
              }`}>
                <div className="relative">
                  <button
                    onClick={() => setShowQualityMenu((v) => !v)}
                    className={`flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors ${
                      isMd3 ? 'text-sm text-[var(--on-surface)] hover:bg-[var(--surface-variant)]' : 'font-mono text-[11px] uppercase tracking-wider text-text-muted hover:bg-surface/5 hover:text-text-primary'
                    }`}
                  >
                    <span>{t('call.quality')}: {qualityLabel(qualityLevel, t)}</span>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  {showQualityMenu && (
                    <div className={isMd3 ? '' : 'border-t border-border-strong/50'}>
                      {QUALITY_OPTIONS.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => { onSetQuality(opt); setShowQualityMenu(false); setShowMoreMenu(false) }}
                          className={`w-full px-6 py-2 text-left text-sm transition-colors ${
                            isMd3
                              ? `${qualityLevel === opt ? 'bg-[var(--primary-container,color-mix(in_srgb,var(--primary)_24%,var(--surface)))] text-[var(--on-primary-container,var(--primary))]' : 'text-[var(--on-surface)] hover:bg-[var(--surface-variant)]'}`
                              : `font-mono text-[11px] uppercase tracking-wider ${qualityLevel === opt ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'}`
                          }`}
                        >
                          {qualityLabel(opt, t)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => { setSidePanel(sidePanel === 'debug' ? 'none' : 'debug'); setShowMoreMenu(false) }}
                  className={`flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors ${
                    isMd3 ? 'text-sm text-[var(--on-surface)] hover:bg-[var(--surface-variant)]' : 'font-mono text-[11px] uppercase tracking-wider text-text-muted hover:bg-surface/5 hover:text-text-primary'
                  }`}
                >
                  <Activity className="h-3.5 w-3.5" />
                  {t('call.debugTitle')}
                </button>
                {onPromote && (promoteCandidateIds?.length ?? 0) > 0 && (
                  <button
                    onClick={() => { setShowAddMenu(true); setShowMoreMenu(false) }}
                    disabled={promoteBusy}
                    className={`flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      isMd3 ? 'text-sm text-[var(--on-surface)] hover:bg-[var(--surface-variant)]' : 'font-mono text-[11px] uppercase tracking-wider text-text-muted hover:bg-surface/5 hover:text-text-primary'
                    }`}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    {t('call.addParticipant')}
                  </button>
                )}
              </div>
            )}
            {showAddMenu && (
              <div className="absolute bottom-14 left-1/2 z-50 max-h-64 w-52 -translate-x-1/2 overflow-y-auto border border-border-strong bg-void/95 shadow-2xl backdrop-blur-xl">
                {addCandidates.length === 0 ? (
                  <p className="px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    {t('call.addParticipantNone')}
                  </p>
                ) : (
                  addCandidates.map((c) => (
                    <button
                      key={c.id}
                      disabled={promoteBusy}
                      onClick={() => {
                        setPromoteBusy(true)
                        setShowAddMenu(false)
                        void onPromote?.(c.id)
                          .catch((err) => console.warn('[call] promote failed', err))
                          .finally(() => setPromoteBusy(false))
                      }}
                      className="block w-full truncate px-3 py-2.5 text-left font-mono text-[11px] tracking-wider text-text-primary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan disabled:opacity-50"
                    >
                      {c.username}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {isMd3 && <div className="mx-1 h-8 w-px bg-[var(--outline-variant,var(--border-strong))]" />}

          <button
            onClick={onEndCall}
            className={`flex items-center justify-center transition-all ${
              isMd3
                ? 'h-12 w-12 rounded-full bg-[var(--error,var(--danger))] text-[var(--on-error,var(--on-primary))] hover:opacity-90'
                : 'h-12 w-16 bg-neon-red/10 text-neon-red hover:bg-neon-red hover:text-text-primary'
            }`}
            title={t('call.endCall')}
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>

        <span className="hidden">{tick}</span>
      </div>
    </PortalRoot>
  )
}

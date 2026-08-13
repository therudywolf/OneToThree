'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
  Users,
  Radio,
  Minimize2,
  Headphones,
  HeadphoneOff,
  MessageSquare,
  Activity,
  Grid3X3,
  Focus,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS } from '@/lib/ios'
import {
  isGroupCallCameraOn,
  isGroupCallScreenSharing,
  hasGroupScreenAudio,
  isGroupScreenAudioMuted,
  toggleGroupScreenAudioMuted,
} from '@/lib/group-call-manager'
import { loadMediaPrefs } from '@/lib/media-devices'
import { warmupCameraEffects } from '@/lib/camera-effects'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useCallStore } from '@/store/callStore'
import { useSessionStore } from '@/store/sessionStore'
import { PortalRoot } from '@/components/portal-root'
import { useTranslation } from '@/hooks/use-translation'
import { CallTile } from '@/components/call/call-tile'
import { CallDebugPanel } from '@/components/call/call-debug-panel'
import { CallParticipantsPanel, type ParticipantRow } from '@/components/call/call-participants-panel'

type Props = {
  userId: string
  username: string
  onEndCall: () => void
  onToggleMute: () => void
  /** Toggle the camera; returns the resulting camera-on state. */
  onToggleVideo: () => Promise<boolean>
  /** Toggle screen-share; returns the resulting screen-sharing state. */
  onToggleScreenShare: () => Promise<boolean>
}

function getGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-1 sm:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 sm:grid-cols-3'
  return 'grid-cols-3'
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

// --- MAIN GROUP CALL SCREEN ---

export function GroupCallScreen({
  userId,
  username,
  onEndCall,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
}: Props) {
  const { t } = useTranslation()
  const localStream = useGroupCallStore((s) => s.localStream)
  const localScreenStream = useGroupCallStore((s) => s.localScreenStream)
  const remoteStreams = useGroupCallStore((s) => s.remoteStreams)
  const participants = useGroupCallStore((s) => s.participants)
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const transport = useGroupCallStore((s) => s.transport)
  const roomId = useGroupCallStore((s) => s.roomId)
  const peerConnections = useGroupCallStore((s) => s.peerConnections)
  const showParticipantPanel = useGroupCallStore((s) => s.showParticipantPanel)
  const setShowParticipantPanel = useGroupCallStore((s) => s.setShowParticipantPanel)
  const localMediaRev = useGroupCallStore((s) => s.localMediaRev)
  const deafened = useCallStore((s) => s.deafened)
  const setDeafened = useCallStore((s) => s.setDeafened)
  const chatOpen = useCallStore((s) => s.chatOpen)
  const setChatOpen = useCallStore((s) => s.setChatOpen)

  const [elapsed, setElapsed] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [showDebug, setShowDebug] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  // Seed from the manager's LIVE media state, not from props/false — minimizing
  // fully unmounts this screen, so on expand these must re-read the actual track
  // state or the camera/screen-share buttons show (and toggle) the wrong/inverted
  // state after a minimize→expand cycle (#4).
  const [isScreenSharing, setIsScreenSharing] = useState(() => isGroupCallScreenSharing())
  const [isCameraOn, setIsCameraOn] = useState(() => isGroupCallCameraOn())
  const [screenAudioMuted, setScreenAudioMuted] = useState(() => isGroupScreenAudioMuted())
  const [isMobileDevice, setIsMobileDevice] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'spotlight'>('grid')
  const [pinnedId, setPinnedId] = useState<string | null>(null)

  useEffect(() => {
    setIsMobileDevice(isAndroidMobile() || isIOSOrIPadOS())
  }, [])

  // Warm the segmentation runtime while the call UI is up (see 1:1 overlay).
  useEffect(() => {
    if (loadMediaPrefs().camEffect !== 'none') warmupCameraEffects()
  }, [])

  // Hotkeys: Ctrl+Shift+M mute, Ctrl+Shift+D deafen (skip while typing).
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
      } else if (key === 'D') {
        e.preventDefault()
        useCallStore.getState().setDeafened(!useCallStore.getState().deafened)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleMute])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)')
    const apply = () => setIsNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // Timer — seed the start time in the store once so it survives minimize→expand
  // remounts instead of resetting to 00:00 (#12).
  useEffect(() => {
    let start = useGroupCallStore.getState().callStartTime
    if (!start) {
      start = Date.now()
      useGroupCallStore.getState().setCallStartTime(start)
    }
    const startAt = start
    setElapsed(Date.now() - startAt)
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startAt)
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  // Auto-hide controls on desktop
  useEffect(() => {
    if (isMobileDevice) {
      setShowControls(true)
      return
    }
    let timeout: ReturnType<typeof setTimeout>
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
  }, [isMobileDevice])

  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams])
  // '#screen' entries are LiveKit screen-share streams — extra TILES, not people.
  const totalCount = 1 + remoteEntries.filter(([id]) => !id.endsWith('#screen')).length

  // Auto-spotlight: a shared screen wins, then the dominant speaker in big
  // rooms (unless manually pinned).
  const speakingId = useMemo(
    () => Object.values(participants).find((p) => p.isSpeaking)?.userId ?? null,
    [participants]
  )
  const screenEntryId = remoteEntries.find(([id]) => id.endsWith('#screen'))?.[0] ?? null
  const autoSpotlightId =
    screenEntryId ??
    (totalCount >= 7 && speakingId ? speakingId : remoteEntries[0]?.[0] ?? userId)
  const spotlightId = pinnedId ?? autoSpotlightId

  // Jump to spotlight when a remote screen share appears.
  const hadScreenRef = useRef(false)
  useEffect(() => {
    const has = screenEntryId !== null
    if (has && !hadScreenRef.current) setLayout('spotlight')
    hadScreenRef.current = has
  }, [screenEntryId])

  // Release a manual pin when the pinned tile disappears (#7). Never clears
  // a self-pin (the local user is always present).
  useEffect(() => {
    if (!pinnedId || pinnedId === userId) return
    if (pinnedId === `${userId}#screen`) {
      if (!localScreenStream) setPinnedId(null)
      return
    }
    if (!participants[pinnedId] && !remoteStreams[pinnedId]) {
      setPinnedId(null)
    }
  }, [pinnedId, participants, remoteStreams, userId, localScreenStream])

  const pinToggle = useCallback((id: string) => {
    setPinnedId((prev) => (prev === id ? null : id))
    setLayout('spotlight')
  }, [])

  const audioMuted = localStream?.getAudioTracks().some((t_) => !t_.enabled) ?? false
  const isAudioRelay = transport === 'audio_relay'
  const videoOff = !isCameraOn && !isScreenSharing

  const openInCallChat = useCallback(() => {
    if (roomId) useSessionStore.getState().setActiveChatId(roomId)
    if (isNarrow) {
      useGroupCallStore.getState().setIsMiniPlayer(true)
      return
    }
    setChatOpen(!chatOpen)
  }, [roomId, isNarrow, chatOpen, setChatOpen])

  if (!isInGroupCall || !localStream) return null

  const handleVideoToggle = async () => {
    setIsCameraOn(await onToggleVideo())
  }

  const handleScreenShareToggle = async () => {
    const sharing = await onToggleScreenShare()
    setIsScreenSharing(sharing)
  }

  const chatShrink = chatOpen && !isNarrow

  const localTile = (
    <CallTile
      peerId={userId}
      stream={localStream}
      label={username}
      isLocal
      micMuted={audioMuted}
      camOff={videoOff}
      pinned={pinnedId === userId}
      onPinToggle={() => pinToggle(userId)}
      mediaRev={localMediaRev}
    />
  )

  const localScreenTile = localScreenStream ? (
    <CallTile
      peerId={`${userId}#screen`}
      stream={localScreenStream}
      label={`${username} · ${t('call.screenSharing')}`}
      isLocal
      screenSharing
      pinned={pinnedId === `${userId}#screen`}
      onPinToggle={() => pinToggle(`${userId}#screen`)}
      mediaRev={localMediaRev}
    />
  ) : null

  const remoteTile = (id: string, stream: MediaStream | null, showPin = true) => {
    const isScreenTile = id.endsWith('#screen')
    const ownerId = isScreenTile ? id.slice(0, -'#screen'.length) : id
    const ownerName = participants[ownerId]?.username ?? ownerId.slice(0, 8)
    return (
      <CallTile
        peerId={id}
        stream={stream}
        label={isScreenTile ? `${ownerName} · ${t('call.screenSharing')}` : ownerName}
        micMuted={!isScreenTile && (participants[id]?.isMuted ?? false)}
        camOff={!isScreenTile && (participants[id]?.isVideoOff ?? false)}
        screenSharing={isScreenTile}
        pinned={pinnedId === id}
        onPinToggle={() => pinToggle(id)}
        showPin={showPin}
      />
    )
  }

  const participantRows: ParticipantRow[] = [
    {
      userId,
      label: username,
      isLocal: true,
      micMuted: audioMuted,
      camOff: videoOff,
      screenSharing: isScreenSharing,
    },
    ...Object.values(participants)
      .filter((p) => p.userId !== userId)
      .map((p) => ({
        userId: p.userId,
        label: p.username,
        micMuted: p.isMuted,
        camOff: p.isVideoOff,
        speaking: p.isSpeaking,
        connectionState: p.connectionState,
      })),
  ]

  return (
    <PortalRoot>
      {/* Clamped to the VISUAL viewport (see .p13-call-surface in globals.css) —
          `inset-y-0` alone pushes the control bar below the fold. */}
      <div
        className="p13-call-surface fixed left-0 top-0 z-[200] flex flex-col bg-void font-mono"
        style={{ right: chatShrink ? 'min(400px, 45vw)' : 0 }}
        role="dialog"
      >
        {/* HEADER */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-strong bg-void/50 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping bg-neon-cyan opacity-75" />
              <span className="relative inline-flex h-2 w-2 bg-neon-cyan" />
            </span>
            <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">
              {t('groupCall.title')} // <span className="text-text-primary">NODES: {totalCount}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isScreenSharing && (
              <span className="hidden items-center gap-1.5 border border-neon-cyan/50 bg-neon-cyan/10 px-2 py-0.5 sm:flex">
                <Monitor className="h-3 w-3 text-neon-cyan" />
                <span className="font-mono text-[9px] uppercase tracking-wider text-neon-cyan">
                  {t('call.screenSharing')}
                </span>
              </span>
            )}
            {isAudioRelay && (
              <span className="flex items-center gap-1.5 border border-accent-2/40 bg-accent-2/15 px-2 py-0.5">
                <Radio className="h-3 w-3 text-accent-2" />
                <span className="font-mono text-[9px] uppercase tracking-wider text-accent-2">
                  {t('groupCall.audioRelay')}
                </span>
              </span>
            )}
            <p className="text-xs tracking-wider text-neon-cyan/70">
              [{formatDuration(elapsed)}]
            </p>
            <button
              type="button"
              onClick={() => useGroupCallStore.getState().setIsMiniPlayer(true)}
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
          <div className="min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-elevated to-void p-2">
            {layout === 'spotlight' || pinnedId ? (
              <div className="flex h-full flex-col gap-2">
                <div className="min-h-0 flex-1">
                  {spotlightId === userId
                    ? localTile
                    : spotlightId === `${userId}#screen`
                      ? localScreenTile
                      : remoteTile(spotlightId, remoteStreams[spotlightId] ?? null)}
                </div>
                <div className="scrollbar-none flex shrink-0 gap-2 overflow-x-auto pb-1">
                  {spotlightId !== userId && (
                    <div className="h-24 w-36 flex-shrink-0">{localTile}</div>
                  )}
                  {localScreenTile && spotlightId !== `${userId}#screen` && (
                    <div className="h-24 w-36 flex-shrink-0">{localScreenTile}</div>
                  )}
                  {remoteEntries
                    .filter(([id]) => id !== spotlightId)
                    .map(([id, stream]) => (
                      <div key={id} className="h-24 w-36 flex-shrink-0">
                        {remoteTile(id, stream, false)}
                      </div>
                    ))}
                </div>
              </div>
            ) : (
              <div className={`grid h-full auto-rows-fr gap-2 ${getGridClass(totalCount + (localScreenTile ? 1 : 0))}`}>
                {localTile}
                {localScreenTile ? <div className="min-h-0">{localScreenTile}</div> : null}
                {remoteEntries.map(([id, stream]) => (
                  <div key={id} className="min-h-0">{remoteTile(id, stream)}</div>
                ))}
              </div>
            )}
          </div>

          {(showParticipantPanel || showDebug) && (
            <aside className="w-[300px] max-w-[85vw] shrink-0 border-l border-border-strong">
              {showDebug ? (
                <CallDebugPanel
                  peers={peerConnections}
                  labels={Object.fromEntries(
                    Object.values(participants).map((p) => [p.userId, p.username])
                  )}
                  extraLines={[
                    `transport: ${transport}`,
                    ...(transport === 'livekit' ? [t('call.debugLivekitNote')] : []),
                    ...(isAudioRelay ? [t('call.debugRelayNote')] : []),
                  ]}
                  onClose={() => setShowDebug(false)}
                />
              ) : (
                <CallParticipantsPanel
                  rows={participantRows}
                  onClose={() => setShowParticipantPanel(false)}
                />
              )}
            </aside>
          )}
        </div>

        {/* CONTROL BAR */}
        <div
          className={`absolute left-2 right-2 flex items-center justify-center border border-border-strong bg-void/90 shadow-2xl backdrop-blur-xl transition-all duration-300 md:left-1/2 md:right-auto md:max-w-[calc(100%-1rem)] md:-translate-x-1/2 ${
            showControls
              ? 'translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-4 opacity-0'
          }`}
          style={{ bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {/* Mute */}
          <button
            onClick={onToggleMute}
            className={`flex h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:w-14 ${
              audioMuted
                ? 'bg-danger/30 text-neon-red hover:bg-danger/30'
                : 'text-text-primary hover:bg-surface/5 hover:text-text-primary'
            }`}
            title={audioMuted ? t('call.unmute') : t('call.mute')}
            aria-label={audioMuted ? t('call.unmute') : t('call.mute')}
          >
            {audioMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* Deafen */}
          <button
            onClick={() => setDeafened(!deafened)}
            className={`flex h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:w-14 ${
              deafened
                ? 'bg-danger/30 text-neon-red hover:bg-danger/30'
                : 'text-text-primary hover:bg-surface/5 hover:text-text-primary'
            }`}
            title={deafened ? t('call.undeafen') : t('call.deafen')}
            aria-label={deafened ? t('call.undeafen') : t('call.deafen')}
            aria-pressed={deafened}
          >
            {deafened ? <HeadphoneOff className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
          </button>

          {/* Camera */}
          <button
            onClick={isAudioRelay ? undefined : handleVideoToggle}
            disabled={isAudioRelay}
            className={`flex h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:w-14 ${
              isAudioRelay || !isCameraOn
                ? 'bg-void/50 text-text-muted/70 hover:bg-elevated'
                : 'text-text-primary hover:bg-surface/5 hover:text-text-primary'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            title={isCameraOn ? t('call.videoOff') : t('call.videoOn')}
            aria-label={isCameraOn ? t('call.videoOff') : t('call.videoOn')}
            aria-pressed={isCameraOn}
          >
            {isCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>

          {/* Screen Share (desktop only) */}
          {!isMobileDevice && !isAudioRelay && (
            <button
              onClick={handleScreenShareToggle}
              className={`hidden h-12 w-12 items-center justify-center border-r border-border-strong transition-colors sm:flex md:w-14 ${
                isScreenSharing
                  ? 'bg-neon-cyan/10 text-neon-cyan'
                  : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'
              }`}
              title={
                isScreenSharing
                  ? t('call.stopScreenShare')
                  : t('call.startScreenShare')
              }
            >
              {isScreenSharing ? (
                <MonitorOff className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Screen-share AUDIO mute — visible only while sharing with audio. */}
          {isScreenSharing && hasGroupScreenAudio() && (
            <button
              onClick={() => setScreenAudioMuted(toggleGroupScreenAudioMuted())}
              className={`hidden h-12 w-12 items-center justify-center border-r border-border-strong transition-colors sm:flex md:w-14 ${
                screenAudioMuted
                  ? 'bg-danger/30 text-neon-red'
                  : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'
              }`}
              title={screenAudioMuted ? t('call.screenAudioOn') : t('call.screenAudioOff')}
              aria-label={screenAudioMuted ? t('call.screenAudioOn') : t('call.screenAudioOff')}
              aria-pressed={screenAudioMuted}
            >
              {screenAudioMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          )}

          {/* Layout toggle */}
          <button
            onClick={() => { setLayout(layout === 'grid' ? 'spotlight' : 'grid'); if (layout === 'spotlight') setPinnedId(null) }}
            className="hidden h-12 w-12 items-center justify-center border-r border-border-strong text-text-muted transition-colors hover:bg-surface/5 hover:text-text-primary md:flex md:w-14"
            title={t('call.toggleLayout')}
            aria-label={t('call.toggleLayout')}
          >
            {layout === 'grid' && !pinnedId ? <Focus className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
          </button>

          {/* Chat */}
          <button
            onClick={openInCallChat}
            className={`flex h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:w-14 ${
              chatOpen && !isNarrow
                ? 'bg-neon-cyan/10 text-neon-cyan'
                : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'
            }`}
            title={t('call.openChat')}
            aria-label={t('call.openChat')}
            aria-pressed={chatOpen && !isNarrow}
          >
            <MessageSquare className="h-4 w-4" />
          </button>

          {/* Participants */}
          <button
            onClick={() => { setShowDebug(false); setShowParticipantPanel(!showParticipantPanel) }}
            className={`flex h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:w-14 ${
              showParticipantPanel
                ? 'bg-neon-cyan/10 text-neon-cyan'
                : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'
            }`}
            title={t('groupCall.participants')}
            aria-label={t('groupCall.participants')}
          >
            <div className="relative">
              <Users className="h-4 w-4" />
              <span className="absolute -right-2 -top-1.5 font-mono text-[8px] text-neon-cyan">
                {totalCount}
              </span>
            </div>
          </button>

          {/* Debug */}
          <button
            onClick={() => { setShowParticipantPanel(false); setShowDebug(!showDebug) }}
            className={`hidden h-12 w-12 items-center justify-center border-r border-border-strong transition-colors md:flex md:w-14 ${
              showDebug
                ? 'bg-neon-cyan/10 text-neon-cyan'
                : 'text-text-muted hover:bg-surface/5 hover:text-text-primary'
            }`}
            title={t('call.debugTitle')}
            aria-label={t('call.debugTitle')}
            aria-pressed={showDebug}
          >
            <Activity className="h-4 w-4" />
          </button>

          {/* End Call */}
          <button
            onClick={onEndCall}
            className="flex h-12 w-14 items-center justify-center bg-neon-red/10 text-neon-red transition-all hover:bg-neon-red hover:text-text-primary md:w-16"
            title={t('call.endCall')}
            aria-label={t('call.endCall')}
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      </div>
    </PortalRoot>
  )
}

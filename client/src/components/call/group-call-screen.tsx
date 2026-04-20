'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
  Users,
  MoreVertical,
  Hand,
  X,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { isAndroidMobile } from '@/lib/android'
import { isIOSOrIPadOS } from '@/lib/ios'
import { useGroupCallStore, type GroupCallParticipant } from '@/store/groupCallStore'
import { PortalRoot } from '@/components/portal-root'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  userId: string
  username: string
  onEndCall: () => void
  onToggleMute: () => void
  onToggleVideo: () => void
  onToggleScreenShare: () => Promise<boolean>
}

// --- LAYOUT HELPERS ---

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

// --- PARTICIPANT TILE ---

function ParticipantTile({
  stream,
  label,
  isMuted,
  isVideoOff,
  isSpeaking,
  isLocal,
  connectionState,
  onClick,
  isSpotlighted,
}: {
  stream: MediaStream | null
  label: string
  isMuted: boolean
  isVideoOff: boolean
  isSpeaking: boolean
  isLocal: boolean
  connectionState?: string
  onClick?: () => void
  isSpotlighted?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const hasVideo = stream ? stream.getVideoTracks().some((t) => t.enabled) : false

  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (!stream) return

    if (hasVideo && v) {
      v.srcObject = stream
      void v.play().catch(() => {})
      if (a) {
        a.srcObject = null
        a.pause()
      }
    } else if (!hasVideo && a && !isLocal) {
      a.srcObject = stream
      void a.play().catch(() => {})
      if (v) v.srcObject = null
    }

    return () => {
      if (v) v.srcObject = null
      if (a) {
        a.srcObject = null
        a.pause()
      }
    }
  }, [stream, hasVideo, isLocal])

  const speakingBorder = isSpeaking
    ? 'border-neon-cyan shadow-[0_0_12px_rgba(0,255,255,0.3)]'
    : 'border-border-strong'

  return (
    <div
      className={`relative overflow-hidden bg-void transition-all duration-200 border ${speakingBorder} ${
        isSpotlighted ? 'col-span-full row-span-2 min-h-[50vh]' : ''
      }`}
      onClick={onClick}
    >
      {!isLocal && <audio ref={audioRef} className="hidden" playsInline />}

      {hasVideo && stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          controls={false}
          className={`w-full h-full object-cover filter contrast-110 ${
            isLocal ? 'transform scale-x-[-1]' : ''
          }`}
        />
      ) : (
        <div className="flex w-full h-full items-center justify-center bg-void min-h-[120px]">
          <div className="space-y-2 text-center">
            <div
              className={`mx-auto h-14 w-14 rounded-full flex items-center justify-center border ${
                isSpeaking
                  ? 'border-neon-cyan bg-neon-cyan/10'
                  : 'border-border-strong bg-void'
              }`}
            >
              <span className="font-mono text-lg uppercase text-text-muted">
                {label.slice(0, 2)}
              </span>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
              {label}
            </p>
          </div>
        </div>
      )}

      {/* Name + Status overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-void/80 to-transparent px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-primary/80 truncate max-w-[70%]">
            {label}
          </span>
          <div className="flex items-center gap-1">
            {isMuted && (
              <MicOff className="h-3 w-3 text-neon-red" />
            )}
            {isVideoOff && (
              <VideoOff className="h-3 w-3 text-text-muted" />
            )}
            {connectionState === 'failed' && (
              <span className="font-mono text-[8px] text-neon-red uppercase">FAIL</span>
            )}
          </div>
        </div>
      </div>

      {/* Speaking glow ring */}
      {isSpeaking && (
        <div className="absolute inset-0 border-2 border-neon-cyan/50 pointer-events-none animate-pulse" />
      )}
    </div>
  )
}

// --- PARTICIPANT PANEL ---

function ParticipantPanel({
  participants,
  onClose,
}: {
  participants: Record<string, GroupCallParticipant>
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="absolute bottom-20 left-0 right-0 max-h-[60vh] bg-void/95 border-t border-border-strong backdrop-blur-xl z-30 overflow-y-auto"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-strong">
        <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
          {t('groupCall.participants')} ({Object.keys(participants).length + 1})
        </span>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="divide-y divide-border-strong">
        {Object.values(participants).map((p) => (
          <div
            key={p.userId}
            className="flex items-center justify-between px-4 py-2.5"
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center border ${
                  p.isSpeaking
                    ? 'border-neon-cyan bg-neon-cyan/10'
                    : 'border-border-strong bg-void'
                }`}
              >
                <span className="font-mono text-[10px] uppercase text-text-muted">
                  {p.username.slice(0, 2)}
                </span>
              </div>
              <div>
                <p className="font-mono text-xs text-text-primary">{p.username}</p>
                <p className="font-mono text-[9px] text-text-muted/70 uppercase">
                  {p.connectionState === 'connected' || p.connectionState === 'completed'
                    ? 'LINKED'
                    : p.connectionState === 'failed'
                      ? 'FAILED'
                      : 'CONNECTING'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {p.isMuted && <MicOff className="h-3.5 w-3.5 text-neon-red" />}
              {p.isVideoOff && <VideoOff className="h-3.5 w-3.5 text-text-muted/70" />}
              {p.isSpeaking && (
                <span className="h-2 w-2 rounded-full bg-neon-cyan animate-pulse" />
              )}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  )
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
  const remoteStreams = useGroupCallStore((s) => s.remoteStreams)
  const participants = useGroupCallStore((s) => s.participants)
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const showParticipantPanel = useGroupCallStore((s) => s.showParticipantPanel)
  const setShowParticipantPanel = useGroupCallStore((s) => s.setShowParticipantPanel)

  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())
  const [showControls, setShowControls] = useState(true)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [isMobileDevice, setIsMobileDevice] = useState(false)
  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  const [showMoreMenu, setShowMoreMenu] = useState(false)

  useEffect(() => {
    setIsMobileDevice(isAndroidMobile() || isIOSOrIPadOS())
  }, [])

  // Timer
  useEffect(() => {
    startRef.current = Date.now()
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startRef.current)
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

  // Auto-spotlight dominant speaker when 7+ participants
  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams])
  const totalCount = 1 + remoteEntries.length
  const useDominantSpeaker = totalCount >= 7

  useEffect(() => {
    if (!useDominantSpeaker) {
      setSpotlightId(null)
      return
    }
    // Find the first speaking participant
    const speaking = Object.values(participants).find((p) => p.isSpeaking)
    if (speaking && spotlightId !== speaking.userId) {
      setSpotlightId(speaking.userId)
    }
  }, [participants, useDominantSpeaker, spotlightId])

  const audioMuted = localStream?.getAudioTracks().some((t) => !t.enabled) ?? false
  const videoOff =
    localStream?.getVideoTracks().length === 0 ||
    (localStream?.getVideoTracks().some((t) => !t.enabled) ?? true)

  if (!isInGroupCall || !localStream) return null

  const handleScreenShareToggle = async () => {
    if (isScreenSharing) {
      // Can't easily revert from here — toggle will handle
      setIsScreenSharing(false)
    } else {
      const ok = await onToggleScreenShare()
      if (ok) setIsScreenSharing(true)
    }
  }

  return (
    <PortalRoot>
      <div className="fixed inset-0 z-[200] flex flex-col bg-void font-mono" role="dialog">
        {/* HEADER */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-strong bg-void/50 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full bg-neon-cyan opacity-75" />
              <span className="relative inline-flex h-2 w-2 bg-neon-cyan" />
            </span>
            <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">
              {t('groupCall.title')} // <span className="text-text-primary">NODES: {totalCount}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isScreenSharing && (
              <span className="flex items-center gap-1.5 border border-neon-cyan/50 bg-neon-cyan/10 px-2 py-0.5">
                <Monitor className="h-3 w-3 text-neon-cyan" />
                <span className="font-mono text-[9px] uppercase tracking-wider text-neon-cyan">
                  {t('call.screenSharing')}
                </span>
              </span>
            )}
            <p className="text-xs text-neon-cyan/70 tracking-wider">
              [{formatDuration(elapsed)}]
            </p>
          </div>
        </div>

        {/* STREAMS GRID */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-2 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-elevated to-void">
          {useDominantSpeaker && spotlightId ? (
            // DOMINANT SPEAKER LAYOUT
            <div className="flex flex-col h-full gap-2">
              {/* Spotlight */}
              <div className="flex-1 min-h-[50vh]">
                {spotlightId === userId ? (
                  <ParticipantTile
                    stream={localStream}
                    label={username}
                    isMuted={audioMuted}
                    isVideoOff={videoOff}
                    isSpeaking={false}
                    isLocal
                    isSpotlighted
                  />
                ) : (
                  <ParticipantTile
                    stream={remoteStreams[spotlightId] ?? null}
                    label={participants[spotlightId]?.username ?? 'UNKNOWN'}
                    isMuted={participants[spotlightId]?.isMuted ?? false}
                    isVideoOff={participants[spotlightId]?.isVideoOff ?? false}
                    isSpeaking={participants[spotlightId]?.isSpeaking ?? false}
                    isLocal={false}
                    connectionState={participants[spotlightId]?.connectionState}
                    isSpotlighted
                  />
                )}
              </div>
              {/* Bottom strip */}
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
                {spotlightId !== userId && (
                  <div
                    className="flex-shrink-0 w-32 h-24 cursor-pointer"
                    onClick={() => setSpotlightId(userId)}
                  >
                    <ParticipantTile
                      stream={localStream}
                      label={username}
                      isMuted={audioMuted}
                      isVideoOff={videoOff}
                      isSpeaking={false}
                      isLocal
                    />
                  </div>
                )}
                {remoteEntries
                  .filter(([id]) => id !== spotlightId)
                  .map(([id, stream]) => (
                    <div
                      key={id}
                      className="flex-shrink-0 w-32 h-24 cursor-pointer"
                      onClick={() => setSpotlightId(id)}
                    >
                      <ParticipantTile
                        stream={stream}
                        label={participants[id]?.username ?? id.slice(0, 8)}
                        isMuted={participants[id]?.isMuted ?? false}
                        isVideoOff={participants[id]?.isVideoOff ?? false}
                        isSpeaking={participants[id]?.isSpeaking ?? false}
                        isLocal={false}
                        connectionState={participants[id]?.connectionState}
                      />
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            // GRID LAYOUT (2x2, 3x2, etc.)
            <div className={`grid gap-2 h-full auto-rows-fr ${getGridClass(totalCount)}`}>
              <ParticipantTile
                stream={localStream}
                label={username}
                isMuted={audioMuted}
                isVideoOff={videoOff}
                isSpeaking={false}
                isLocal
              />
              {remoteEntries.map(([id, stream]) => (
                <ParticipantTile
                  key={id}
                  stream={stream}
                  label={participants[id]?.username ?? id.slice(0, 8)}
                  isMuted={participants[id]?.isMuted ?? false}
                  isVideoOff={participants[id]?.isVideoOff ?? false}
                  isSpeaking={participants[id]?.isSpeaking ?? false}
                  isLocal={false}
                  connectionState={participants[id]?.connectionState}
                  onClick={() => useDominantSpeaker && setSpotlightId(id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* PARTICIPANT PANEL */}
        <AnimatePresence>
          {showParticipantPanel && (
            <ParticipantPanel
              participants={participants}
              onClose={() => setShowParticipantPanel(false)}
            />
          )}
        </AnimatePresence>

        {/* CONTROL BAR */}
        <div
          className={`absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center bg-void/90 border border-border-strong backdrop-blur-xl shadow-2xl transition-all duration-300 pb-[env(safe-area-inset-bottom)] ${
            showControls
              ? 'translate-y-0 opacity-100'
              : 'translate-y-4 opacity-0 pointer-events-none'
          }`}
        >
          {/* Mute */}
          <button
            onClick={onToggleMute}
            className={`flex h-12 w-14 items-center justify-center border-r border-border-strong transition-colors ${
              audioMuted
                ? 'bg-danger/30 text-neon-red hover:bg-danger/30'
                : 'text-text-primary hover:text-text-primary hover:bg-surface/5'
            }`}
            title={audioMuted ? t('call.unmute') : t('call.mute')}
          >
            {audioMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* Camera */}
          <button
            onClick={onToggleVideo}
            className={`flex h-12 w-14 items-center justify-center border-r border-border-strong transition-colors ${
              videoOff
                ? 'bg-void/50 text-text-muted/70 hover:bg-elevated'
                : 'text-text-primary hover:text-text-primary hover:bg-surface/5'
            }`}
            title={videoOff ? t('call.videoOn') : t('call.videoOff')}
          >
            {videoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </button>

          {/* Screen Share (desktop only) */}
          {!isMobileDevice && (
            <button
              onClick={handleScreenShareToggle}
              className={`hidden sm:flex h-12 w-14 items-center justify-center border-r border-border-strong transition-colors ${
                isScreenSharing
                  ? 'bg-neon-cyan/10 text-neon-cyan'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface/5'
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

          {/* Participants */}
          <button
            onClick={() => setShowParticipantPanel(!showParticipantPanel)}
            className={`flex h-12 w-14 items-center justify-center border-r border-border-strong transition-colors ${
              showParticipantPanel
                ? 'bg-neon-cyan/10 text-neon-cyan'
                : 'text-text-muted hover:text-text-primary hover:bg-surface/5'
            }`}
            title={t('groupCall.participants')}
          >
            <div className="relative">
              <Users className="h-4 w-4" />
              <span className="absolute -top-1.5 -right-2 font-mono text-[8px] text-neon-cyan">
                {totalCount}
              </span>
            </div>
          </button>

          {/* More menu */}
          <div className="relative">
            <button
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              className="flex h-12 w-14 items-center justify-center border-r border-border-strong text-text-muted hover:text-text-primary hover:bg-surface/5 transition-colors"
              title={t('groupCall.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <AnimatePresence>
              {showMoreMenu && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute bottom-14 right-0 border border-border-strong bg-void/95 backdrop-blur-xl shadow-2xl z-50 min-w-[160px]"
                >
                  <button
                    onClick={() => setShowMoreMenu(false)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary hover:bg-surface/5 transition-colors"
                  >
                    <Hand className="h-3.5 w-3.5" />
                    {t('groupCall.raiseHand')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* End Call */}
          <button
            onClick={onEndCall}
            className="flex h-12 w-16 items-center justify-center bg-neon-red/10 text-neon-red hover:bg-neon-red hover:text-text-primary transition-all"
            title={t('call.endCall')}
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      </div>
    </PortalRoot>
  )
}

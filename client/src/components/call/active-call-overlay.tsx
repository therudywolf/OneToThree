'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  RefreshCw,
  Video,
  VideoOff,
  Maximize2,
  Minimize2,
  Grid3X3,
  Focus,
  Zap,
} from 'lucide-react'
import { applyPreferredAudioOutput, loadMediaPrefs, saveMediaPrefs } from '@/lib/media-devices'
import { isAndroidMobile } from '@/lib/android'
import { useCallStore } from '@/store/callStore'
import { PortalRoot } from '@/components/portal-root'

type Props = {
  onEndCall: () => void
  onToggleMute: () => void
  onToggleCamera: () => void
  onToggleVideo?: () => void
  onSwitchCamera: () => void
  isScreenSharing: boolean
  onToggleScreenShare: () => void
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function gridCols(count: number, layoutMode: 'grid' | 'focus'): string {
  if (layoutMode === 'focus') {
    return 'grid-cols-1'
  }
  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-1 md:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 md:grid-cols-3'
  return 'grid-cols-3 md:grid-cols-4'
}

function PeerTile({
  peerId,
  stream,
  label,
  muted,
  remoteMicMuted,
  remoteCamOff,
  isFullscreen,
  onFullscreenToggle,
  isDragging,
  position,
  isFocused,
  onFocusToggle,
  layoutMode,
}: {
  peerId: string
  stream: MediaStream
  label: string
  muted?: boolean
  remoteMicMuted?: boolean
  remoteCamOff?: boolean
  isFullscreen?: boolean
  onFullscreenToggle?: () => void
  isDragging?: boolean
  position?: { x: number; y: number }
  isFocused?: boolean
  onFocusToggle?: () => void
  layoutMode?: 'grid' | 'focus'
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const hasVideo = stream.getVideoTracks().length > 0
  const [tapCount, setTapCount] = useState(0)
  const tapTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (hasVideo && v) {
      v.srcObject = stream
      void v.play().catch(() => {
        /* iOS may block autoplay until gesture; user can tap overlay */
      })
      if (!muted) void applyPreferredAudioOutput(v)
      if (a) {
        a.srcObject = null
        a.pause()
      }
    } else if (!hasVideo && a) {
      a.srcObject = stream
      void a.play().catch(() => {
        /* autoplay policy */
      })
      if (!muted) void applyPreferredAudioOutput(a)
      if (v) v.srcObject = null
    }
    return () => {
      if (v) v.srcObject = null
      if (a) {
        a.srcObject = null
        a.pause()
      }
    }
  }, [stream, hasVideo, muted])

  const handleDoubleTap = () => {
    setTapCount((c) => c + 1)
    if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current)
    if (tapCount === 1 && onFullscreenToggle && label === 'REMOTE') {
      onFullscreenToggle()
      setTapCount(0)
    } else {
      tapTimeoutRef.current = setTimeout(() => setTapCount(0), 300)
    }
  }

  const handleClick = () => {
    if (layoutMode === 'focus' && onFocusToggle) {
      onFocusToggle()
    } else {
      handleDoubleTap()
    }
  }

  const showRemoteHints =
    label === 'REMOTE' && (remoteMicMuted || remoteCamOff)

  const tileStyle = isDragging && position
    ? {
        position: 'fixed' as const,
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: '150px',
        height: '200px',
        zIndex: 199,
      }
    : undefined

  return (
    <div
      ref={containerRef}
      className={`relative border shadow-[0_0_8px_rgba(0,255,255,0.2)] ${
        isFullscreen
          ? 'fixed inset-0 z-[210] border-neon-red'
          : isFocused
            ? 'border-neon-cyan ring-2 ring-neon-cyan/50'
            : 'border-neon-cyan/40'
      }`}
      style={tileStyle}
      onClick={handleClick}
    >
      <div className="flex items-center justify-between border-b border-neon-cyan/30 bg-black px-2 py-1">
        <p className="font-mono text-[9px] uppercase tracking-widest text-neon-cyan">
          {label} :: {peerId.slice(0, 8)}…
        </p>
        {label === 'REMOTE' && onFullscreenToggle && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onFullscreenToggle()
            }}
            className="p-1 hover:text-neon-cyan"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3 w-3" strokeWidth={2} />
            ) : (
              <Maximize2 className="h-3 w-3" strokeWidth={2} />
            )}
          </button>
        )}
      </div>
      <audio ref={audioRef} className="hidden" playsInline muted={muted} />
      {hasVideo ? (
        <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            controls={false}
            className="h-full w-full bg-black object-cover"
            style={{ objectFit: 'cover', transform: 'scaleX(-1)' }}
          />
          {showRemoteHints ? (
            <div className="pointer-events-none absolute bottom-1 left-1 flex flex-wrap gap-1">
              {remoteMicMuted ? (
                <span className="border border-neon-red bg-black/85 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-neon-red shadow-[0_0_8px_rgba(255,0,0,0.35)]">
                  MIC MUTED
                </span>
              ) : null}
              {remoteCamOff ? (
                <span className="border border-neon-red bg-black/85 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-neon-red shadow-[0_0_8px_rgba(255,0,0,0.35)]">
                  CAM OFF
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative flex w-full items-center justify-center bg-black" style={{ aspectRatio: '16/9' }}>
          <div className="space-y-1 text-center">
            <div className="mx-auto h-12 w-12 rounded-full border border-neon-red bg-black" />
            <p className="font-mono text-[9px] uppercase text-neon-red">AUDIO</p>
          </div>
          {showRemoteHints ? (
            <div className="pointer-events-none absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-wrap justify-center gap-1">
              {remoteMicMuted ? (
                <span className="border border-neon-red bg-black/90 px-2 py-0.5 font-mono text-[8px] uppercase text-neon-red">
                  MIC MUTED
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}


export function ActiveCallOverlay({
  onEndCall,
  onToggleMute,
  onToggleCamera,
  onToggleVideo,
  onSwitchCamera,
  isScreenSharing,
  onToggleScreenShare,
}: Props) {
  const isCalling = useCallStore((s) => s.isCalling)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)
  const remotePeerMedia = useCallStore((s) => s.remotePeerMedia)

  const [tick, setTick] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)
  const [screenShareAllowed, setScreenShareAllowed] = useState(true)
  const [fullscreenPeerId, setFullscreenPeerId] = useState<string | null>(null)
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null)
  const [isDraggingLocal, setIsDraggingLocal] = useState(false)
  const dragStateRef = useRef<{ startX: number; startY: number } | null>(null)
  const [layoutMode, setLayoutMode] = useState<'grid' | 'focus'>('grid')
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [lowBandwidth, setLowBandwidth] = useState(() => loadMediaPrefs().lowBandwidth)

  useEffect(() => {
    setScreenShareAllowed(!isAndroidMobile())
  }, [])

  // Auto-hide controls after 3 seconds of inactivity
  useEffect(() => {
    const resetControlsTimeout = () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
      setControlsVisible(true)
      controlsTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false)
      }, 3000)
    }

    const handleMouseMove = () => resetControlsTimeout()
    const handleMouseLeave = () => {
      controlsTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false)
      }, 1000)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseleave', handleMouseLeave)

    resetControlsTimeout()

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseleave', handleMouseLeave)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [])

  const remoteEntries = useMemo(
    () => Object.entries(remoteStreams),
    [remoteStreams]
  )

  const tileCount = 1 + remoteEntries.length

  useEffect(() => {
    if (!isCalling || !localStream) {
      startRef.current = null
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    const id = window.setInterval(() => {
      if (startRef.current) {
        setElapsed(Date.now() - startRef.current)
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [isCalling, localStream])

  const audioMuted =
    localStream?.getAudioTracks().some((t) => !t.enabled) ?? false
  const hasCameraTrack = (localStream?.getVideoTracks().length ?? 0) > 0
  const videoOff =
    localStream?.getVideoTracks().length === 0
      ? true
      : (localStream?.getVideoTracks().some((t) => !t.enabled) ?? false)

  function handleMute() {
    onToggleMute()
    setTick((x) => x + 1)
  }

  function handleCam() {
    onToggleCamera()
    setTick((x) => x + 1)
  }

  function handleScreenShare() {
    void onToggleScreenShare()
    setTick((x) => x + 1)
  }

  function toggleLayout() {
    setLayoutMode((prev) => {
      const next = prev === 'grid' ? 'focus' : 'grid'
      if (next === 'focus') {
        setFocusedPeerId(remoteEntries[0]?.[0] || 'LOCAL')
      } else {
        setFocusedPeerId(null)
      }
      return next
    })
  }

  function toggleBandwidth() {
    const newValue = !lowBandwidth
    setLowBandwidth(newValue)
    saveMediaPrefs({ lowBandwidth: newValue })
  }

  function handlePeerFocus(peerId: string) {
    if (layoutMode === 'focus') {
      setFocusedPeerId(peerId)
    }
  }

  if (!isCalling || !localStream) return null

  return (
    <PortalRoot>
      <div
        className="fixed inset-0 z-[200] flex flex-col bg-black"
        role="dialog"
        aria-label="Active call"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-red-500/50 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-[0_0_10px_rgba(255,0,0,0.35)]">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-neon-cyan">
            :: LIVE_SESSION [{tileCount} PEER{tileCount > 1 ? 'S' : ''}]
          </p>
          <p className="font-mono text-sm tabular-nums text-neon-red">
            {formatDuration(elapsed)}
          </p>
        </div>

        <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain p-3 [-webkit-overflow-scrolling:touch]">
          {layoutMode === 'focus' && focusedPeerId ? (
            <div className="relative flex-1">
              <div className="relative min-h-[320px] w-full">
                {focusedPeerId === 'LOCAL' ? (
                  <PeerTile
                    peerId="LOCAL"
                    stream={localStream}
                    label="YOU (FOCUSED)"
                    muted
                    layoutMode={layoutMode}
                  />
                ) : (
                  remoteEntries
                    .filter(([peerId]) => peerId === focusedPeerId)
                    .map(([peerId, stream]) => {
                      const hint = remotePeerMedia[peerId]
                      return (
                        <PeerTile
                          key={peerId}
                          peerId={peerId}
                          stream={stream}
                          label="REMOTE (FOCUSED)"
                          remoteMicMuted={hint?.micMuted}
                          remoteCamOff={hint?.cameraOff}
                          layoutMode={layoutMode}
                        />
                      )
                    })
                )}
              </div>

              {focusedPeerId !== 'LOCAL' && localStream ? (
                <div className="pointer-events-auto absolute bottom-4 right-4 z-20 w-44 rounded border border-neon-cyan/50 bg-black/90 p-1 shadow-[0_0_20px_rgba(0,255,255,0.25)]">
                  <PeerTile
                    peerId="LOCAL"
                    stream={localStream}
                    label="YOU"
                    muted
                    onFocusToggle={() => handlePeerFocus('LOCAL')}
                    layoutMode={layoutMode}
                  />
                </div>
              ) : null}

              {focusedPeerId === 'LOCAL' && remoteEntries.length > 0 ? (
                <div className="mt-3 flex gap-2 overflow-x-auto">
                  {remoteEntries.map(([peerId, stream]) => {
                    const hint = remotePeerMedia[peerId]
                    return (
                      <div key={peerId} className="flex-shrink-0 w-36">
                        <PeerTile
                          peerId={peerId}
                          stream={stream}
                          label="REMOTE"
                          remoteMicMuted={hint?.micMuted}
                          remoteCamOff={hint?.cameraOff}
                          onFocusToggle={() => handlePeerFocus(peerId)}
                          layoutMode={layoutMode}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : (
            <div className={`grid gap-3 ${gridCols(tileCount, layoutMode)}`}>
              <PeerTile
                peerId="LOCAL"
                stream={localStream}
                label="YOU"
                muted
                onFocusToggle={() => handlePeerFocus('LOCAL')}
                layoutMode={layoutMode}
              />
              {remoteEntries.map(([peerId, stream]) => {
                const hint = remotePeerMedia[peerId]
                return (
                  <PeerTile
                    key={peerId}
                    peerId={peerId}
                    stream={stream}
                    label="REMOTE"
                    remoteMicMuted={hint?.micMuted}
                    remoteCamOff={hint?.cameraOff}
                    onFocusToggle={() => handlePeerFocus(peerId)}
                    layoutMode={layoutMode}
                  />
                )
              })}
            </div>
          )}
        </div>

      <div className={`pb-safe flex shrink-0 flex-wrap items-center justify-center gap-3 border-t border-red-500/50 bg-black px-3 py-3 pt-3 shadow-[0_0_10px_rgba(255,0,0,0.35)] md:gap-4 md:px-4 md:py-4 transition-opacity duration-300 ${
        controlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}>
        <button
          type="button"
          onClick={handleMute}
          className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none bg-black p-3 hover:bg-neon-cyan/10 ${
            audioMuted
              ? 'border-2 border-neon-red text-neon-red shadow-[0_0_14px_rgba(255,0,0,0.35)]'
              : 'border border-neon-cyan text-neon-cyan'
          }`}
          aria-label={audioMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {audioMuted ? (
            <MicOff className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Mic className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
        {onToggleVideo && (
          <button
            type="button"
            onClick={() => {
              void onToggleVideo()
              setTick((x) => x + 1)
            }}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border bg-black p-3 hover:bg-neon-cyan/10 ${
              hasCameraTrack && !videoOff
                ? 'border-neon-cyan text-neon-cyan'
                : 'border-zinc-600 text-zinc-400'
            }`}
            aria-label={hasCameraTrack && !videoOff ? 'Disable video' : 'Enable video'}
          >
            {hasCameraTrack && !videoOff ? (
              <Video className="h-5 w-5" strokeWidth={1.5} />
            ) : (
              <VideoOff className="h-5 w-5" strokeWidth={1.5} />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={handleCam}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border border-neon-red bg-black p-3 text-neon-red hover:bg-neon-red/10"
          aria-label={videoOff ? 'Enable camera' : 'Disable camera'}
        >
          {videoOff ? (
            <VideoOff className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Video className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
        {hasCameraTrack && !videoOff ? (
          <button
            type="button"
            onClick={() => void onSwitchCamera()}
            disabled={isScreenSharing}
            title="Switch camera (front / back)"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border border-zinc-500 bg-black p-3 text-zinc-300 hover:border-neon-cyan hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Switch camera"
          >
            <RefreshCw className="h-5 w-5" strokeWidth={1.5} />
          </button>
        ) : null}
        {screenShareAllowed ? (
          <button
            type="button"
            onClick={handleScreenShare}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
            className={`hidden min-h-[44px] min-w-[44px] items-center justify-center rounded-none border bg-black p-3 md:flex ${
              isScreenSharing
                ? 'border-neon-cyan text-neon-cyan shadow-[0_0_12px_rgba(34,211,238,0.25)] hover:bg-neon-cyan/10'
                : 'border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:text-zinc-200'
            }`}
            aria-label={isScreenSharing ? 'Stop screen share' : 'Share screen'}
          >
            <Monitor className="h-5 w-5" strokeWidth={1.5} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggleBandwidth}
          title={lowBandwidth ? 'Switch to HD' : 'Switch to SD'}
          className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border bg-black p-3 hover:bg-neon-cyan/10 ${
            lowBandwidth
              ? 'border-neon-cyan text-neon-cyan shadow-[0_0_12px_rgba(34,211,238,0.25)]'
              : 'border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:text-zinc-200'
          }`}
          aria-label={lowBandwidth ? 'Switch to HD' : 'Switch to SD'}
        >
          <Zap className="h-5 w-5" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={toggleLayout}
          title={layoutMode === 'grid' ? 'Switch to focus mode' : 'Switch to grid mode'}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border border-zinc-500 bg-black p-3 text-zinc-300 hover:border-neon-cyan hover:text-neon-cyan"
          aria-label={layoutMode === 'grid' ? 'Focus mode' : 'Grid mode'}
        >
          {layoutMode === 'grid' ? (
            <Focus className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Grid3X3 className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={onEndCall}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-none border-2 border-neon-red bg-red-950/50 p-3 text-neon-red hover:bg-neon-red/20"
          aria-label="End call"
        >
          <PhoneOff className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
      <span className="hidden">{tick}</span>
      </div>
    </PortalRoot>
  )
}

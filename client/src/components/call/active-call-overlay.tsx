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

function getGridClass(count: number, layoutMode: 'grid' | 'focus'): string {
  if (layoutMode === 'focus') return 'grid-cols-1'
  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-1 md:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 md:grid-cols-3'
  return 'grid-cols-3 md:grid-cols-4'
}

// --- PEER TILE (TERMINAL NODE) ---
function PeerTile({
  peerId,
  stream,
  label,
  muted = false,
  remoteMicMuted = false,
  remoteCamOff = false,
  isFullscreen = false,
  onFullscreenToggle,
  isDragging = false,
  position,
  isFocused = false,
  onFocusToggle,
  layout = 'grid',
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
  layout?: 'grid' | 'focus'
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const hasVideo = stream.getVideoTracks().length > 0
  const [tapCount, setTapCount] = useState(0)
  const tapTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (hasVideo && v) {
      v.srcObject = stream
      void v.play().catch(() => {})
      if (!muted) void applyPreferredAudioOutput(v)
      if (a) {
        a.srcObject = null
        a.pause()
      }
    } else if (!hasVideo && a) {
      a.srcObject = stream
      void a.play().catch(() => {})
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

  const handleInteraction = () => {
    if (layout === 'focus' && onFocusToggle) {
      onFocusToggle()
      return
    }
    // Double tap mechanic
    setTapCount((c) => c + 1)
    if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current)
    if (tapCount === 1 && onFullscreenToggle && !label.includes('LOCAL')) {
      onFullscreenToggle()
      setTapCount(0)
    } else {
      tapTimeoutRef.current = setTimeout(() => setTapCount(0), 300)
    }
  }

  const isRemote = !label.includes('LOCAL')
  const showWarnings = isRemote && (remoteMicMuted || remoteCamOff)

  const containerClass = layout === 'grid'
    ? 'relative w-full h-full bg-black border border-neutral-900 group'
    : 'relative w-full h-full bg-black group'

  const videoClass = layout === 'grid'
    ? 'w-full h-full object-cover filter contrast-125 grayscale-[20%]'
    : 'w-full h-full object-cover filter contrast-125 grayscale-[20%]'

  const isLocalPIP = layout === 'focus' && !isRemote
  const localPIPClass = 'absolute bottom-24 right-6 w-32 h-48 md:w-48 md:h-72 object-cover border border-neon-cyan/50 shadow-[0_0_15px_rgba(0,255,255,0.15)] z-10'

  return (
    <div
      className={`relative bg-black transition-all duration-200 ${
        isFullscreen
          ? 'fixed inset-0 z-[210] border-2 border-neon-red'
          : isFocused
            ? 'border border-neon-cyan ring-1 ring-neon-cyan/30'
            : isLocalPIP 
              ? localPIPClass 
              : 'border border-neutral-800 hover:border-neutral-700'
      }`}
      style={isDragging && position ? {
        position: 'fixed', left: `${position.x}px`, top: `${position.y}px`, width: '150px', height: '200px', zIndex: 199
      } : undefined}
      onClick={handleInteraction}
    >
      {/* NODE HEADER */}
      <div className="absolute top-0 left-0 w-full z-10 flex items-center justify-between border-b border-white/5 bg-black/80 backdrop-blur-sm px-2 py-1 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <p className="font-mono text-[10px] uppercase tracking-widest text-white/70">
          <span className={isRemote ? 'text-neon-cyan' : 'text-zinc-500'}>[{label}]</span> :: {peerId.slice(0, 8)}
        </p>
        {isRemote && onFullscreenToggle && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onFullscreenToggle(); }}
            className="text-white/50 hover:text-neon-cyan transition-colors"
          >
            {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
        )}
      </div>

      <audio ref={audioRef} className="hidden" playsInline muted={muted} />
      
      {hasVideo ? (
        <div className={containerClass} style={layout === 'grid' ? undefined : { aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            controls={false}
            className={isLocalPIP ? 'w-full h-full object-cover transform scale-x-[-1]' : `${videoClass} transform scale-x-[-1]`}
          />
        </div>
      ) : (
        <div className="flex w-full h-full items-center justify-center bg-zinc-950 inset-0 absolute">
          <div className="space-y-2 text-center">
            <div className="mx-auto h-10 w-10 border border-neutral-800 bg-neutral-900 flex items-center justify-center">
              <span className="block w-2 h-2 bg-neon-red animate-pulse" />
            </div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-600">OPTICS_OFFLINE</p>
          </div>
        </div>
      )}

      {/* STATUS OVERLAYS */}
      {showWarnings && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-1 z-10">
          {remoteMicMuted && (
            <span className="border border-neon-red/50 bg-black/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-neon-red backdrop-blur-md">
              AUDIO_CUT
            </span>
          )}
          {remoteCamOff && hasVideo && (
            <span className="border border-neon-red/50 bg-black/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-neon-red backdrop-blur-md">
              FEED_LOST
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// --- MAIN OVERLAY ---
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
  const [layout, setLayout] = useState<'grid' | 'focus'>('grid')
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null)
  const [showControls, setShowControls] = useState(true)
  const [isHD, setIsHD] = useState(() => !loadMediaPrefs().lowBandwidth)

  useEffect(() => {
    setScreenShareAllowed(!isAndroidMobile())
  }, [])

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

  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams])
  const tileCount = 1 + remoteEntries.length

  useEffect(() => {
    if (!isCalling || !localStream) {
      startRef.current = null
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    const id = window.setInterval(() => {
      if (startRef.current) setElapsed(Date.now() - startRef.current)
    }, 500)
    return () => window.clearInterval(id)
  }, [isCalling, localStream])

  const audioMuted = localStream?.getAudioTracks().some((t) => !t.enabled) ?? false
  const hasCameraTrack = (localStream?.getVideoTracks().length ?? 0) > 0
  const videoOff = localStream?.getVideoTracks().length === 0 || (localStream?.getVideoTracks().some((t) => !t.enabled) ?? false)

  function toggleLayout() {
    setLayout((prev) => {
      const next = prev === 'grid' ? 'focus' : 'grid'
      if (next === 'focus') setFocusedPeerId(remoteEntries[0]?.[0] || 'LOCAL_UNIT')
      else setFocusedPeerId(null)
      return next
    })
  }

  function toggleBandwidth() {
    const newValue = !isHD
    setIsHD(newValue)
    saveMediaPrefs({ lowBandwidth: !newValue })
  }

  if (!isCalling || !localStream) return null

  return (
    <PortalRoot>
      <div className="fixed inset-0 z-[200] flex flex-col bg-zinc-950 font-mono" role="dialog">
        {/* HEADER BAR */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-900 bg-black/50 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full bg-neon-cyan opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 bg-neon-cyan"></span>
            </span>
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-400">
              SYS.LINK // <span className="text-white">NODES: {tileCount}</span>
            </p>
          </div>
          <p className="text-xs text-neon-cyan/70 tracking-wider">
            [{formatDuration(elapsed)}]
          </p>
        </div>

        {/* STREAMS CONTAINER */}
        <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain p-2 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900 to-black">
          {layout === 'focus' && focusedPeerId ? (
            <div className="relative flex-1 h-full flex flex-col">
              <div className="relative flex-1 w-full min-h-[50vh]">
                {focusedPeerId === 'LOCAL_UNIT' ? (
                  <PeerTile peerId="LOCAL_UNIT" stream={localStream} label="LOCAL_UNIT" muted layout={layout} />
                ) : (
                  remoteEntries.filter(([id]) => id === focusedPeerId).map(([id, stream]) => (
                    <PeerTile
                      key={id} peerId={id} stream={stream} label="REMOTE_LINK"
                      remoteMicMuted={remotePeerMedia[id]?.micMuted}
                      remoteCamOff={remotePeerMedia[id]?.cameraOff} layout={layout}
                    />
                  ))
                )}
              </div>

              {/* LOCAL PIP IN FOCUS MODE */}
              {focusedPeerId !== 'LOCAL_UNIT' && (
                 <PeerTile peerId="LOCAL_UNIT" stream={localStream} label="LOCAL_UNIT" muted onFocusToggle={() => setFocusedPeerId('LOCAL_UNIT')} layout={layout} />
              )}

              {/* FOCUS THUMBNAILS */}
              {focusedPeerId === 'LOCAL_UNIT' && remoteEntries.length > 0 && (
                <div className="mt-2 flex gap-2 overflow-x-auto border-t border-neutral-900 pt-2 px-2">
                  {remoteEntries.map(([id, stream]) => (
                    <div key={id} className="flex-shrink-0 w-40 h-28 cursor-pointer opacity-70 hover:opacity-100 transition-opacity">
                      <PeerTile
                        peerId={id} stream={stream} label="REMOTE_LINK"
                        remoteMicMuted={remotePeerMedia[id]?.micMuted}
                        remoteCamOff={remotePeerMedia[id]?.cameraOff}
                        onFocusToggle={() => setFocusedPeerId(id)} layout="grid"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className={`grid gap-2 h-full ${getGridClass(tileCount, layout)}`}>
              <PeerTile peerId="LOCAL_UNIT" stream={localStream} label="LOCAL_UNIT" muted onFocusToggle={() => setFocusedPeerId('LOCAL_UNIT')} layout={layout} />
              {remoteEntries.map(([id, stream]) => (
                <PeerTile
                  key={id} peerId={id} stream={stream} label="REMOTE_LINK"
                  remoteMicMuted={remotePeerMedia[id]?.micMuted}
                  remoteCamOff={remotePeerMedia[id]?.cameraOff}
                  onFocusToggle={() => setFocusedPeerId(id)} layout={layout}
                />
              ))}
            </div>
          )}
        </div>

        {/* TACTICAL CONTROLS */}
        <div className={`absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center bg-black/90 border border-neutral-800 backdrop-blur-xl shadow-2xl transition-all duration-300 ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
          
          <button onClick={() => { onToggleMute(); setTick(t => t + 1); }} className={`flex h-12 w-14 items-center justify-center border-r border-neutral-800 transition-colors ${audioMuted ? 'bg-red-950/30 text-neon-red hover:bg-red-900/50' : 'text-neutral-300 hover:text-white hover:bg-white/5'}`}>
            {audioMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {onToggleVideo && (
            <button onClick={() => { onToggleVideo(); setTick(t => t + 1); }} className={`flex h-12 w-14 items-center justify-center border-r border-neutral-800 transition-colors ${!hasCameraTrack || videoOff ? 'bg-neutral-900/50 text-neutral-600 hover:bg-neutral-800' : 'text-neutral-300 hover:text-white hover:bg-white/5'}`}>
              {!hasCameraTrack || videoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
            </button>
          )}

          <button onClick={() => { onToggleCamera(); setTick(t => t + 1); }} className="flex h-12 w-14 items-center justify-center border-r border-neutral-800 text-neutral-400 hover:text-neon-cyan hover:bg-neon-cyan/5 transition-colors">
            {videoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </button>

          {hasCameraTrack && !videoOff && (
            <button onClick={onSwitchCamera} disabled={isScreenSharing} className="flex h-12 w-14 items-center justify-center border-r border-neutral-800 text-neutral-400 hover:text-white hover:bg-white/5 disabled:opacity-20 transition-colors">
              <RefreshCw className="h-4 w-4" />
            </button>
          )}

          {screenShareAllowed && (
            <button onClick={() => { onToggleScreenShare(); setTick(t => t + 1); }} className={`hidden md:flex h-12 w-14 items-center justify-center border-r border-neutral-800 transition-colors ${isScreenSharing ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}>
              <Monitor className="h-4 w-4" />
            </button>
          )}

          <button onClick={toggleBandwidth} className={`flex h-12 w-14 items-center justify-center border-r border-neutral-800 transition-colors ${isHD ? 'text-neon-cyan bg-neon-cyan/5' : 'text-neutral-500 hover:text-neutral-300'}`}>
            <Zap className="h-4 w-4" />
          </button>

          <button onClick={toggleLayout} className="flex h-12 w-14 items-center justify-center border-r border-neutral-800 text-neutral-400 hover:text-white hover:bg-white/5 transition-colors">
            {layout === 'grid' ? <Focus className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
          </button>

          <button onClick={onEndCall} className="flex h-12 w-16 items-center justify-center bg-neon-red/10 text-neon-red hover:bg-neon-red hover:text-black transition-all">
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
        
        <span className="hidden">{tick}</span>
      </div>
    </PortalRoot>
  )
}
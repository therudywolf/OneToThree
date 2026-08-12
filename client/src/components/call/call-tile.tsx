'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Maximize2,
  Minimize2,
  MicOff,
  MonitorUp,
  Lock,
  Radio,
  PictureInPicture2,
  Scan,
  Pin,
  PinOff,
} from 'lucide-react'
import type { PeerConnectionType } from '@/store/callStore'
import { useSpeaking, useVideoTrack } from '@/hooks/use-call-media'
import { isVideoPipSupported, toggleVideoPip } from '@/lib/call-pip'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: CALL_TILE (shared by 1:1 and group screens)
 *
 * One participant's video/avatar surface with the controls Discord users
 * expect on a tile: pin/unpin, fit↔fill, native fullscreen, video-PiP,
 * plus status badges (mic muted, screen share, P2P/relay) and a speaking ring.
 * The tile listens to TRACK events (mute/unmute/ended) — a remote camera
 * hard-off keeps the stream identity, so React alone would never repaint.
 */
export function CallTile({
  peerId,
  stream,
  label,
  isLocal = false,
  micMuted = false,
  camOff = false,
  screenSharing = false,
  connectionType,
  pinned = false,
  onPinToggle,
  speakingEnabled = true,
  fillHeight = true,
  showPin = true,
  mediaRev = 0,
}: {
  peerId: string
  stream: MediaStream | null
  label: string
  isLocal?: boolean
  micMuted?: boolean
  /** Peer signalled camera-off (avatar placeholder even if a stale track remains). */
  camOff?: boolean
  screenSharing?: boolean
  connectionType?: PeerConnectionType
  pinned?: boolean
  onPinToggle?: () => void
  speakingEnabled?: boolean
  /** false → tile keeps a 16:9 aspect instead of filling the parent. */
  fillHeight?: boolean
  showPin?: boolean
  /** Bumped after local stream mutations (script addTrack fires no events). */
  mediaRev?: number
}) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode) === 'md3'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { active: videoActive } = useVideoTrack(stream, mediaRev)
  const speaking = useSpeaking(stream, speakingEnabled && !micMuted)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  // Screen shares default to "fit" (contain) — cropping a desktop is useless;
  // camera feeds default to "fill" (cover). User can override per tile.
  const [fitOverride, setFitOverride] = useState<'cover' | 'contain' | null>(null)
  const objectFit = fitOverride ?? (screenSharing ? 'contain' : 'cover')

  // Video shows when a live unmuted track exists AND the peer didn't signal
  // camera-off (screen share overrides the camera-off signal).
  const showVideo = videoActive && (!camOff || screenSharing || isLocal)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (showVideo && stream) {
      if (v.srcObject !== stream) v.srcObject = stream
      void v.play().catch(() => {})
    } else {
      v.srcObject = null
    }
    return () => {
      if (v) v.srcObject = null
    }
  }, [stream, showVideo])

  // Track native fullscreen state for the toggle icon.
  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Track PiP state (user can close PiP from the floating window itself).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const enter = () => setPipActive(true)
    const leave = () => setPipActive(false)
    v.addEventListener('enterpictureinpicture', enter)
    v.addEventListener('leavepictureinpicture', leave)
    return () => {
      v.removeEventListener('enterpictureinpicture', enter)
      v.removeEventListener('leavepictureinpicture', leave)
    }
  }, [showVideo])

  const toggleFullscreen = () => {
    const el = containerRef.current
    // iOS Safari has no element fullscreen API — hide the failure, not the app.
    if (!el || typeof el.requestFullscreen !== 'function') return
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void el.requestFullscreen().catch(() => {})
    }
  }

  // Mirror the local CAMERA only — never a shared screen.
  const mirrored = isLocal && !screenSharing

  return (
    <div
      ref={containerRef}
      data-peer={peerId}
      onClick={onPinToggle}
      className={`group relative min-h-0 overflow-hidden bg-void transition-all duration-200 ${
        fillHeight ? 'h-full w-full' : 'w-full'
      } ${
        speaking
          ? 'border-2 border-neon-cyan shadow-[0_0_12px_rgba(0,255,255,0.35)]'
          : pinned
            ? 'border border-neon-cyan/60'
            : 'border border-border-strong'
      } ${onPinToggle ? 'cursor-pointer' : ''}`}
      style={fillHeight ? undefined : { aspectRatio: '16/9' }}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          className={`h-full w-full ${mirrored ? 'scale-x-[-1] transform' : ''}`}
          style={{ objectFit }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-void">
          <div className="space-y-2 text-center">
            <div
              className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full border ${
                speaking ? 'border-neon-cyan bg-neon-cyan/10' : 'border-border-strong bg-void'
              }`}
            >
              <span className={`${isMd3 ? '' : 'font-mono '}text-lg uppercase text-text-muted`}>
                {label.slice(0, 2)}
              </span>
            </div>
            <p className={`${isMd3 ? '' : 'font-mono '}text-[10px] uppercase tracking-widest text-text-muted`}>
              {label}
            </p>
          </div>
        </div>
      )}

      {/* Hover controls (top-right): fit, PiP, fullscreen, pin */}
      <div
        className="absolute right-1 top-1 z-10 flex items-center gap-0.5 opacity-100 transition-opacity duration-200 md:opacity-0 md:group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        {showVideo ? (
          <button
            type="button"
            onClick={() => setFitOverride(objectFit === 'cover' ? 'contain' : 'cover')}
            className="flex h-7 w-7 items-center justify-center bg-void/70 text-text-primary/70 backdrop-blur-sm transition-colors hover:text-neon-cyan"
            title={t('call.tileFit')}
            aria-label={t('call.tileFit')}
          >
            <Scan className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {showVideo && !isLocal && isVideoPipSupported() ? (
          <button
            type="button"
            onClick={() => {
              const v = videoRef.current
              if (v) void toggleVideoPip(v).then(setPipActive)
            }}
            className={`flex h-7 w-7 items-center justify-center bg-void/70 backdrop-blur-sm transition-colors ${
              pipActive ? 'text-neon-cyan' : 'text-text-primary/70 hover:text-neon-cyan'
            }`}
            title={t('call.tilePip')}
            aria-label={t('call.tilePip')}
          >
            <PictureInPicture2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggleFullscreen}
          className="flex h-7 w-7 items-center justify-center bg-void/70 text-text-primary/70 backdrop-blur-sm transition-colors hover:text-neon-cyan"
          title={t('call.tileFullscreen')}
          aria-label={t('call.tileFullscreen')}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        {showPin && onPinToggle ? (
          <button
            type="button"
            onClick={onPinToggle}
            className={`flex h-7 w-7 items-center justify-center bg-void/70 backdrop-blur-sm transition-colors ${
              pinned ? 'text-neon-cyan' : 'text-text-primary/70 hover:text-neon-cyan'
            }`}
            title={pinned ? t('call.tileUnpin') : t('call.tilePin')}
            aria-label={pinned ? t('call.tileUnpin') : t('call.tilePin')}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>

      {/* Name + status (bottom-left) */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex items-end justify-between bg-gradient-to-t from-void/80 to-transparent px-2 py-1.5">
        <span className={`${isMd3 ? '' : 'font-mono '}max-w-[70%] truncate text-[10px] uppercase tracking-wider text-text-primary/85`}>
          {isLocal ? `${label}` : label}
        </span>
        <span className="flex items-center gap-1.5">
          {connectionType && connectionType !== 'unknown' ? (
            connectionType === 'p2p' ? (
              <Lock className="h-3 w-3 text-success" aria-label="P2P" />
            ) : (
              <Radio className="h-3 w-3 text-accent-2" aria-label="RELAY" />
            )
          ) : null}
          {screenSharing ? <MonitorUp className="h-3 w-3 text-neon-cyan" /> : null}
          {micMuted ? <MicOff className="h-3 w-3 text-neon-red" /> : null}
        </span>
      </div>
    </div>
  )
}

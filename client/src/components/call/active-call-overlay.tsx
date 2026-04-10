'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react'
import { applyPreferredAudioOutput } from '@/lib/media-devices'
import { useCallStore } from '@/store/callStore'

type Props = {
  onEndCall: () => void
  onToggleMute: () => void
  onToggleCamera: () => void
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function gridCols(count: number): string {
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
}: {
  peerId: string
  stream: MediaStream
  label: string
  muted?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const hasVideo = stream.getVideoTracks().length > 0

  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (hasVideo && v) {
      v.srcObject = stream
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

  return (
    <div className="relative border border-neon-cyan/40 shadow-[0_0_8px_rgba(0,255,255,0.2)]">
      <p className="border-b border-neon-cyan/30 bg-black px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan">
        {label} :: {peerId.slice(0, 8)}…
      </p>
      <audio ref={audioRef} className="hidden" playsInline />
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className="aspect-video w-full bg-black object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-black">
          <div className="space-y-1 text-center">
            <div className="mx-auto h-12 w-12 rounded-full border border-neon-red bg-black" />
            <p className="font-mono text-[9px] uppercase text-neon-red">AUDIO</p>
          </div>
        </div>
      )}
    </div>
  )
}

export function ActiveCallOverlay({
  onEndCall,
  onToggleMute,
  onToggleCamera,
}: Props) {
  const isCalling = useCallStore((s) => s.isCalling)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)

  const [tick, setTick] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

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

  if (!isCalling || !localStream) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black"
      role="dialog"
      aria-label="Active call"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-red-500/50 px-4 py-3 shadow-[0_0_10px_rgba(255,0,0,0.35)]">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-neon-cyan">
          :: LIVE_SESSION [{tileCount} PEER{tileCount > 1 ? 'S' : ''}]
        </p>
        <p className="font-mono text-sm tabular-nums text-neon-red">
          {formatDuration(elapsed)}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className={`grid gap-3 ${gridCols(tileCount)}`}>
          <PeerTile
            peerId="LOCAL"
            stream={localStream}
            label="YOU"
            muted
          />
          {remoteEntries.map(([peerId, stream]) => (
            <PeerTile
              key={peerId}
              peerId={peerId}
              stream={stream}
              label="REMOTE"
            />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4 border-t border-red-500/50 bg-black px-4 py-4 shadow-[0_0_10px_rgba(255,0,0,0.35)]">
        <button
          type="button"
          onClick={handleMute}
          className="rounded-none border border-neon-cyan bg-black p-3 text-neon-cyan hover:bg-neon-cyan/10"
          aria-label={audioMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {audioMuted ? (
            <MicOff className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Mic className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={handleCam}
          className="rounded-none border border-neon-red bg-black p-3 text-neon-red hover:bg-neon-red/10"
          aria-label={videoOff ? 'Enable camera' : 'Disable camera'}
        >
          {videoOff ? (
            <VideoOff className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Video className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={onEndCall}
          className="rounded-none border-2 border-neon-red bg-red-950/50 p-3 text-neon-red hover:bg-neon-red/20"
          aria-label="End call"
        >
          <PhoneOff className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
      <span className="hidden">{tick}</span>
    </div>
  )
}

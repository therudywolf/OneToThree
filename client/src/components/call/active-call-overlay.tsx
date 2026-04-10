'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react'
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

export function ActiveCallOverlay({
  onEndCall,
  onToggleMute,
  onToggleCamera,
}: Props) {
  const isCalling = useCallStore((s) => s.isCalling)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({})
  const [tick, setTick] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  const remoteEntries = useMemo(
    () => Object.entries(remoteStreams),
    [remoteStreams]
  )

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

  useEffect(() => {
    const el = localVideoRef.current
    if (!el || !localStream || localStream.getVideoTracks().length === 0) {
      return
    }
    el.srcObject = localStream
    return () => {
      el.srcObject = null
    }
  }, [localStream])

  useEffect(() => {
    for (const [peerId, stream] of remoteEntries) {
      if (stream.getVideoTracks().length === 0) continue
      const el = remoteVideoRefs.current[peerId]
      if (el) el.srcObject = stream
    }
    return () => {
      for (const peerId of Object.keys(remoteVideoRefs.current)) {
        const el = remoteVideoRefs.current[peerId]
        if (el) el.srcObject = null
      }
    }
  }, [remoteEntries])

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

  if (!isCalling || !localStream) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black"
      role="dialog"
      aria-label="Active call"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-red-500/50 px-4 py-3 shadow-[0_0_10px_rgba(255,0,0,0.35)]">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-neon-cyan">
          :: LIVE_SESSION
        </p>
        <p className="font-mono text-sm tabular-nums text-neon-red">
          {formatDuration(elapsed)}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="border border-red-500/50 shadow-[0_0_10px_rgba(255,0,0,0.5)]">
            <p className="border-b border-neon-cyan/40 bg-black px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
              LOCAL
            </p>
            {localStream.getVideoTracks().length > 0 ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="aspect-video w-full rounded-none bg-black object-cover"
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-none border-t border-black bg-black font-mono text-xs uppercase tracking-widest text-neon-red">
                AUDIO_ONLY
              </div>
            )}
          </div>

          {remoteEntries.map(([peerId, stream]) => (
            <div
              key={peerId}
              className="border border-cyan-500/50 shadow-[0_0_10px_rgba(0,255,255,0.35)]"
            >
              <p className="border-b border-neon-red/40 bg-black px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-red">
                REMOTE :: {peerId.slice(0, 8)}…
              </p>
              {stream.getVideoTracks().length > 0 ? (
                <video
                  ref={(el) => {
                    remoteVideoRefs.current[peerId] = el
                  }}
                  autoPlay
                  playsInline
                  className="aspect-video w-full rounded-none bg-black object-cover"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-none border-t border-black bg-black font-mono text-xs uppercase tracking-widest text-neon-cyan">
                  AUDIO_ONLY
                </div>
              )}
            </div>
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
          className="rounded-none border border-neon-red bg-black p-3 text-neon-red hover:bg-neon-red/20"
          aria-label="End call"
        >
          <PhoneOff className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
      <span className="hidden">{tick}</span>
    </div>
  )
}

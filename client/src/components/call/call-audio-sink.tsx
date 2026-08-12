'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useCallStore } from '@/store/callStore'
import { useGroupCallStore } from '@/store/groupCallStore'
import {
  applyPreferredAudioOutput,
  loadMediaPrefs,
  MEDIA_PREFS_CHANGED_EVENT,
} from '@/lib/media-devices'
import { startCallForegroundService, stopCallForegroundService } from '@/lib/native-call-service'

/**
 * Always-mounted remote-audio sink.
 *
 * Peer audio used to be played only by the <audio>/<video> elements inside the
 * full-screen call overlays (ActiveCallOverlay / GroupCallScreen). Those unmount
 * the instant a call is minimized, which silenced the remote peer on every
 * platform (issue #3: "minimizing a call loses the peer's audio; minimize doesn't
 * work anywhere"). This component is mounted once at the chat-app root —
 * independent of the overlay and mini-player — and binds every remote audio
 * TRACK (both 1:1 and group) to a hidden, persistent <audio> element, so audio
 * keeps playing while the call is backgrounded / minimized.
 *
 * One element per TRACK (not per stream): a peer sharing their screen with tab
 * audio has TWO audio tracks in one stream (mic + tab audio), and per-stream
 * playback made mixing both a browser implementation detail. Per-track elements
 * always mix.
 *
 * Per-peer volume and mute-for-me (callStore.peerVolumes / peerLocalMuted)
 * apply here — locally only, never signalled to the peer.
 */
function RemoteAudioTrack({
  track,
  muted,
  volume,
}: {
  track: MediaStreamTrack
  muted: boolean
  volume: number
}) {
  const ref = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stream = new MediaStream([track])
    if (el.srcObject !== stream) el.srcObject = stream
    void el.play().catch(() => {
      /* Autoplay may be blocked until a user gesture; the call accept/initiate
         click primes the audio graph. A later play() (on stream change) succeeds. */
    })
    void applyPreferredAudioOutput(el)
    return () => {
      el.srcObject = null
      el.pause()
    }
  }, [track])
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])
  useEffect(() => {
    if (ref.current) ref.current.volume = Math.min(1, Math.max(0, volume))
  }, [volume])
  return <audio ref={ref} autoPlay playsInline muted={muted} className="hidden" />
}

/** Track a stream's live audio tracks, following addtrack/removetrack/ended. */
function useAudioTracks(stream: MediaStream): MediaStreamTrack[] {
  const [tracks, setTracks] = useState<MediaStreamTrack[]>(() => stream.getAudioTracks())
  useEffect(() => {
    const sync = () => setTracks(stream.getAudioTracks().filter((t) => t.readyState === 'live'))
    sync()
    stream.addEventListener('addtrack', sync)
    stream.addEventListener('removetrack', sync)
    const bound: Array<{ t: MediaStreamTrack; fn: () => void }> = []
    for (const t of stream.getAudioTracks()) {
      const fn = () => sync()
      t.addEventListener('ended', fn)
      bound.push({ t, fn })
    }
    return () => {
      stream.removeEventListener('addtrack', sync)
      stream.removeEventListener('removetrack', sync)
      bound.forEach(({ t, fn }) => t.removeEventListener('ended', fn))
    }
  }, [stream])
  return tracks
}

function RemoteAudio({
  stream,
  muted,
  volume,
}: {
  stream: MediaStream
  muted: boolean
  volume: number
}) {
  const tracks = useAudioTracks(stream)
  return (
    <>
      {tracks.map((t) => (
        <RemoteAudioTrack key={t.id} track={t} muted={muted} volume={volume} />
      ))}
    </>
  )
}

const subscribePrefs = (cb: () => void) => {
  window.addEventListener(MEDIA_PREFS_CHANGED_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(MEDIA_PREFS_CHANGED_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

/** Master call volume from settings, reactive to live changes. */
function useOutputVolume(): number {
  return useSyncExternalStore(
    subscribePrefs,
    () => loadMediaPrefs().outputVolume,
    () => 1
  )
}

export function CallAudioSink() {
  const p2pStreams = useCallStore((s) => s.remoteStreams)
  const groupStreams = useGroupCallStore((s) => s.remoteStreams)
  const deafened = useCallStore((s) => s.deafened)
  const peerVolumes = useCallStore((s) => s.peerVolumes)
  const peerLocalMuted = useCallStore((s) => s.peerLocalMuted)
  const isCalling = useCallStore((s) => s.isCalling)
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const outputVolume = useOutputVolume()

  // Android: hold a microphone foreground service for the lifetime of a call so
  // backgrounding the app doesn't drop the mic / peer audio (issue #3/#13).
  // No-op on web and iOS.
  useEffect(() => {
    if (isCalling || isInGroupCall) startCallForegroundService()
    else stopCallForegroundService()
  }, [isCalling, isInGroupCall])

  return (
    <div aria-hidden className="hidden">
      {Object.entries(p2pStreams).map(([id, stream]) => (
        <RemoteAudio
          key={`p2p:${id}`}
          stream={stream}
          muted={deafened || !!peerLocalMuted[id]}
          volume={(peerVolumes[id] ?? 1) * outputVolume}
        />
      ))}
      {Object.entries(groupStreams).map(([id, stream]) => (
        <RemoteAudio
          key={`grp:${id}`}
          stream={stream}
          muted={deafened || !!peerLocalMuted[id]}
          volume={(peerVolumes[id] ?? 1) * outputVolume}
        />
      ))}
    </div>
  )
}

'use client'

import { useEffect, useRef } from 'react'
import { useCallStore } from '@/store/callStore'
import { useGroupCallStore } from '@/store/groupCallStore'
import { applyPreferredAudioOutput } from '@/lib/media-devices'

/**
 * Always-mounted remote-audio sink.
 *
 * Peer audio used to be played only by the <audio>/<video> elements inside the
 * full-screen call overlays (ActiveCallOverlay / GroupCallScreen). Those unmount
 * the instant a call is minimized, which silenced the remote peer on every
 * platform (issue #3: "minimizing a call loses the peer's audio; minimize doesn't
 * work anywhere"). This component is mounted once at the chat-app root —
 * independent of the overlay and mini-player — and binds every remote MediaStream
 * (both 1:1 and group) to a hidden, persistent <audio> element, so audio keeps
 * playing while the call is backgrounded / minimized.
 *
 * The tiles in the overlays now render VIDEO only (their media elements are muted);
 * this sink is the single source of remote call audio. The local stream is never
 * included here, so a user never hears their own microphone.
 */
function RemoteAudio({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
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
  }, [stream])
  // Deafen = output mute: silence every remote element while deafened (#5/#7).
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])
  return <audio ref={ref} autoPlay playsInline muted={muted} className="hidden" />
}

export function CallAudioSink() {
  const p2pStreams = useCallStore((s) => s.remoteStreams)
  const groupStreams = useGroupCallStore((s) => s.remoteStreams)
  const deafened = useCallStore((s) => s.deafened)
  return (
    <div aria-hidden className="hidden">
      {Object.entries(p2pStreams).map(([id, stream]) => (
        <RemoteAudio key={`p2p:${id}`} stream={stream} muted={deafened} />
      ))}
      {Object.entries(groupStreams).map(([id, stream]) => (
        <RemoteAudio key={`grp:${id}`} stream={stream} muted={deafened} />
      ))}
    </div>
  )
}

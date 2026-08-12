'use client'

import { useEffect, useState } from 'react'

/**
 * PROJECT 13 :: CALL_MEDIA_HOOKS
 * Small reactive hooks over live MediaStream state. React can't see track
 * mutations (streams keep their identity when tracks mute/end/swap), so tiles
 * subscribe to track events explicitly.
 */

/**
 * The primary VIDEO track of a stream, live-updated on addtrack/removetrack/
 * mute/unmute/ended. `active` is what a tile should render video for: a live,
 * unmuted, enabled track. (A remote camera hard-off does replaceTrack(null) —
 * the track object stays in the stream but flips `muted`, with no
 * React-visible change.)
 *
 * `refreshKey` exists for LOCAL streams: `stream.addTrack()` from script fires
 * NO events (`addtrack` is UA-only) and keeps the stream identity, so callers
 * bump a revision counter (callStore.localMediaRev) after local mutations.
 */
export function useVideoTrack(
  stream: MediaStream | null,
  refreshKey = 0
): {
  track: MediaStreamTrack | null
  active: boolean
} {
  const [state, setState] = useState<{ track: MediaStreamTrack | null; active: boolean }>(() => {
    const t = stream?.getVideoTracks()[0] ?? null
    return { track: t, active: !!t && t.readyState === 'live' && !t.muted && t.enabled }
  })

  useEffect(() => {
    if (!stream) {
      setState({ track: null, active: false })
      return
    }
    let bound: Array<{ t: MediaStreamTrack; ev: string; fn: () => void }> = []
    const isActive = (t: MediaStreamTrack) => t.readyState === 'live' && !t.muted && t.enabled
    const sync = () => {
      // Prefer a live & unmuted video track; fall back to the first one.
      const tracks = stream.getVideoTracks()
      const best = tracks.find(isActive) ?? tracks[0] ?? null
      setState((prev) => {
        const active = !!best && isActive(best)
        if (prev.track === best && prev.active === active) return prev
        return { track: best, active }
      })
      // (Re)bind track-level listeners.
      bound.forEach(({ t, ev, fn }) => t.removeEventListener(ev, fn))
      bound = []
      for (const t of tracks) {
        for (const ev of ['mute', 'unmute', 'ended'] as const) {
          const fn = () => sync()
          t.addEventListener(ev, fn)
          bound.push({ t, ev, fn })
        }
      }
    }
    sync()
    const onChange = () => sync()
    stream.addEventListener('addtrack', onChange)
    stream.addEventListener('removetrack', onChange)
    return () => {
      stream.removeEventListener('addtrack', onChange)
      stream.removeEventListener('removetrack', onChange)
      bound.forEach(({ t, ev, fn }) => t.removeEventListener(ev, fn))
    }
  }, [stream, refreshKey])

  return state
}

// One shared AudioContext for all speaking detectors — Safari caps the number
// of simultaneous AudioContexts, and every tile creating its own would hit it.
let speakingCtx: AudioContext | null = null
function getSpeakingContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null
  if (!speakingCtx || speakingCtx.state === 'closed') {
    try {
      speakingCtx = new AudioContext()
    } catch {
      return null
    }
  }
  if (speakingCtx.state === 'suspended') void speakingCtx.resume().catch(() => {})
  return speakingCtx
}

/**
 * Lightweight voice-activity flag for a stream (drives the speaking ring on
 * call tiles). Polls an AnalyserNode ~8×/s; hysteresis keeps the ring from
 * flickering between words.
 */
export function useSpeaking(stream: MediaStream | null, enabled = true): boolean {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    if (!stream || !enabled) {
      setSpeaking(false)
      return
    }
    if (stream.getAudioTracks().length === 0) {
      setSpeaking(false)
      return
    }
    const ctx = getSpeakingContext()
    if (!ctx) return
    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch {
      return
    }
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let holdUntil = 0
    const id = window.setInterval(() => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]!
      const avg = sum / data.length
      const now = Date.now()
      if (avg > 16) holdUntil = now + 400
      setSpeaking((prev) => {
        const next = now < holdUntil
        return prev === next ? prev : next
      })
    }, 130)
    return () => {
      window.clearInterval(id)
      try {
        source.disconnect()
      } catch { /* detached */ }
    }
  }, [stream, enabled])

  return speaking
}

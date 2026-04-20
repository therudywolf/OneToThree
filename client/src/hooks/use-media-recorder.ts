'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isIOSOrIPadOS } from '@/lib/ios'
import { getUserMediaConstraints } from '@/lib/media-devices'
import {
  isMediaPermissionDenied,
  isMediaTooLarge,
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
  MEDIA_TOO_LARGE_CODE,
} from '@/lib/media-limits'

export type CaptureResult = {
  blob: Blob
  mimeType: string
}

/** Preferred first on Android Chrome; then Safari-friendly; then generic; last = browser default. */
const AUDIO_RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  '',
] as const

/** Order: Android WebM VP8+Opus → MP4 → generic WebM → browser default. */
const VIDEO_RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/mp4',
  'video/webm',
  '',
] as const

function createMediaRecorderWithMimeFallback(
  stream: MediaStream,
  candidates: readonly string[]
): MediaRecorder {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('NO_MEDIARECORDER')
  }
  for (const mime of candidates) {
    if (mime === '') {
      try {
        return new MediaRecorder(stream)
      } catch {
        continue
      }
    }
    if (MediaRecorder.isTypeSupported(mime)) {
      try {
        return new MediaRecorder(stream, { mimeType: mime })
      } catch {
        continue
      }
    }
  }
  return new MediaRecorder(stream)
}

function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/mp4'
  for (const mime of AUDIO_RECORDER_MIME_CANDIDATES) {
    if (mime === '') return ''
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/mp4'
  for (const mime of VIDEO_RECORDER_MIME_CANDIDATES) {
    if (mime === '') return ''
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

/**
 * MediaRecorder capture: strict blob assembly, no race conditions.
 */
// If `stopCapture` is called before the MediaRecorder has been wired (the
// user tapped-and-released faster than getUserMedia could resolve) we wait
// at most this many ms for the recorder to materialise before bailing out.
const START_SETTLE_TIMEOUT_MS = 1200

// Recordings shorter than this are considered accidental taps, not real
// voice messages.  This keeps us from uploading 20-byte Opus headers when
// the user just fat-fingered the mic button.  Keep it LOW (≤150ms) so a
// legitimate "hold just long enough for getUserMedia to resolve" still
// produces something useful — otherwise users perceive the button as
// dead when permission dialogs take time to resolve on a slow phone.
const MIN_RECORDING_DURATION_MS = 150

function debugVoice(...args: unknown[]) {
  if (typeof window === 'undefined') return
  if (process.env.NODE_ENV === 'production') return
  // eslint-disable-next-line no-console
  console.debug('[voice]', ...args)
}

export function useMediaRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const kindRef = useRef<'audio' | 'video' | null>(null)
  // Promise that resolves when the current start* call either:
  //   - finishes wiring the recorder (streamRef+recorderRef populated)
  //   - fails (permission denied / unsupported)
  // `stopCapture` awaits this so the tap-and-release race never drops the
  // recording on the floor.
  const startSettleRef = useRef<Promise<boolean> | null>(null)
  const recordStartedAtRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      setPreviewStream(null)
    }
  }, [])

  const beginStart = useCallback(() => {
    let resolveSettle: (ok: boolean) => void = () => {}
    startSettleRef.current = new Promise<boolean>((res) => {
      resolveSettle = res
    })
    return (ok: boolean) => {
      resolveSettle(ok)
      startSettleRef.current = null
    }
  }, [])

  const startVoiceCapture = useCallback(async () => {
    debugVoice('startVoiceCapture: requested')
    const settle = beginStart()
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      setPreviewStream(null)

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
        settle(false)
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia(
        getUserMediaConstraints({ video: false })
      )

      streamRef.current = stream
      setPreviewStream(stream)
      kindRef.current = 'audio'

      const rec = createMediaRecorderWithMimeFallback(
        stream,
        AUDIO_RECORDER_MIME_CANDIDATES
      )

      recorderRef.current = rec

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      rec.start(isIOSOrIPadOS() ? 250 : undefined)
      recordStartedAtRef.current = Date.now()
      setIsRecording(true)
      debugVoice('startVoiceCapture: recorder started', { mime: rec.mimeType })
      settle(true)
    } catch (err) {
      debugVoice('startVoiceCapture: failed', err)
      setPreviewStream(null)
      setError(
        isMediaPermissionDenied(err)
          ? MEDIA_PERMISSION_DENIED_CODE
          : MEDIA_ACCESS_ERROR_MESSAGE
      )
      settle(false)
    }
  }, [beginStart])

  const startVideoCircleCapture = useCallback(async () => {
    debugVoice('startVideoCircleCapture: requested')
    const settle = beginStart()
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      setPreviewStream(null)

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
        settle(false)
        return
      }

      const base = getUserMediaConstraints({ video: true })
      const fromPrefs: MediaTrackConstraints =
        base.video && typeof base.video === 'object'
          ? (base.video as MediaTrackConstraints)
          : {}

      const videoConstraints: MediaTrackConstraints = isIOSOrIPadOS()
        ? {
            ...fromPrefs,
            facingMode: 'user',
          }
        : {
            ...fromPrefs,
            facingMode: 'user',
            width: { ideal: 720 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 1 },
          }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: base.audio,
        video: videoConstraints,
      })

      streamRef.current = stream
      setPreviewStream(stream)
      kindRef.current = 'video'

      const rec = createMediaRecorderWithMimeFallback(
        stream,
        VIDEO_RECORDER_MIME_CANDIDATES
      )

      recorderRef.current = rec

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      rec.start(isIOSOrIPadOS() ? 250 : undefined)
      recordStartedAtRef.current = Date.now()
      setIsRecording(true)
      debugVoice('startVideoCircleCapture: recorder started', { mime: rec.mimeType })
      settle(true)
    } catch (err) {
      debugVoice('startVideoCircleCapture: failed', err)
      setPreviewStream(null)
      setError(
        isMediaPermissionDenied(err)
          ? MEDIA_PERMISSION_DENIED_CODE
          : MEDIA_ACCESS_ERROR_MESSAGE
      )
      settle(false)
    }
  }, [beginStart])

  const stopCapture = useCallback(async (): Promise<CaptureResult | null> => {
    debugVoice('stopCapture: requested')

    // If a start* call is still in flight, wait for it so we don't race it.
    if (startSettleRef.current) {
      const winner = await Promise.race([
        startSettleRef.current,
        new Promise<boolean>((res) => {
          setTimeout(() => res(false), START_SETTLE_TIMEOUT_MS)
        }),
      ])
      debugVoice('stopCapture: start settle complete', { ok: winner })
    }

    const rec = recorderRef.current
    const stream = streamRef.current
    const kind = kindRef.current

    if (!rec || rec.state === 'inactive') {
      debugVoice('stopCapture: no active recorder', {
        hasRec: !!rec,
        state: rec?.state,
      })
      setIsRecording(false)
      setPreviewStream(null)
      return null
    }

    // Reject truly-accidental taps — the user barely touched the mic.
    const durMs = Date.now() - recordStartedAtRef.current
    if (durMs < MIN_RECORDING_DURATION_MS) {
      debugVoice('stopCapture: recording too short, discarding', { durMs })
      try {
        if (rec.state !== 'inactive') rec.stop()
      } catch {
        /* ignore — we're discarding anyway */
      }
      stream?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      recorderRef.current = null
      kindRef.current = null
      chunksRef.current = []
      setIsRecording(false)
      setPreviewStream(null)
      return null
    }

    // Fast UI reset so buttons react instantly
    setIsRecording(false)

    return new Promise((resolve) => {
      let resolved = false
      const finish = (value: CaptureResult | null) => {
        if (resolved) return
        resolved = true
        resolve(value)
      }

      rec.onstop = () => {
        const rawMime =
          rec.mimeType ||
          (kind === 'audio' ? pickAudioMime() : pickVideoMime())
        // Strip codec params so browser doesn't choke on duration detection
        const mime = rawMime.split(';')[0] || rawMime

        const blob = new Blob(chunksRef.current, { type: mime })

        // Clear references AFTER the blob is safely created
        chunksRef.current = []
        recorderRef.current = null
        kindRef.current = null

        stream?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setPreviewStream(null)

        debugVoice('stopCapture: onstop fired', { size: blob.size, mime })

        if (!blob.size) {
          finish(null)
          return
        }
        if (isMediaTooLarge(blob.size)) {
          setError(MEDIA_TOO_LARGE_CODE)
          finish(null)
          return
        }

        finish({ blob, mimeType: mime })
      }

      // Failsafe: if onstop never fires (some Safari builds, backgrounded
      // tab, etc.) don't hang the UI forever — reap after 3s with whatever
      // chunks we already collected.
      const watchdog = setTimeout(() => {
        if (resolved) return
        debugVoice('stopCapture: watchdog fired — finalizing from chunks')
        const mime =
          rec.mimeType ||
          (kind === 'audio' ? pickAudioMime() : pickVideoMime())
        const cleanMime = mime.split(';')[0] || mime
        const blob = new Blob(chunksRef.current, { type: cleanMime })
        chunksRef.current = []
        recorderRef.current = null
        kindRef.current = null
        stream?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setPreviewStream(null)
        if (!blob.size) {
          finish(null)
        } else {
          finish({ blob, mimeType: cleanMime })
        }
      }, 3000)

      // Make sure the watchdog can't leak after a normal onstop.
      const origOnStop = rec.onstop
      rec.onstop = (ev) => {
        clearTimeout(watchdog)
        if (typeof origOnStop === 'function') {
          try {
            ;(origOnStop as (e: Event) => void).call(rec, ev)
          } catch (err) {
            debugVoice('stopCapture: onstop threw', err)
            finish(null)
          }
        }
      }

      try {
        if (rec.state !== 'inactive') {
          rec.requestData?.()
          rec.stop()
        } else {
          clearTimeout(watchdog)
          finish(null)
        }
      } catch (err) {
        debugVoice('stopCapture: rec.stop() threw', err)
        clearTimeout(watchdog)
        finish(null)
      }
    })
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const getStream = useCallback(() => streamRef.current, [])

  return {
    isRecording,
    error,
    clearError,
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream,
    getStream,
  }
}
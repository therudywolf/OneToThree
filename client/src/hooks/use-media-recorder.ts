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
export function useMediaRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const kindRef = useRef<'audio' | 'video' | null>(null)

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      setPreviewStream(null)
    }
  }, [])

  const startVoiceCapture = useCallback(async () => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      setPreviewStream(null)

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
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
      setIsRecording(true)
    } catch (err) {
      setPreviewStream(null)
      setError(
        isMediaPermissionDenied(err)
          ? MEDIA_PERMISSION_DENIED_CODE
          : MEDIA_ACCESS_ERROR_MESSAGE
      )
    }
  }, [])

  const startVideoCircleCapture = useCallback(async () => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      setPreviewStream(null)

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
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
      setIsRecording(true)
    } catch (err) {
      setPreviewStream(null)
      setError(
        isMediaPermissionDenied(err)
          ? MEDIA_PERMISSION_DENIED_CODE
          : MEDIA_ACCESS_ERROR_MESSAGE
      )
    }
  }, [])

  const stopCapture = useCallback(async (): Promise<CaptureResult | null> => {
    const rec = recorderRef.current
    const stream = streamRef.current
    const kind = kindRef.current

    if (!rec || rec.state === 'inactive') {
      setIsRecording(false)
      setPreviewStream(null)
      return null
    }

    // Fast UI reset so buttons react instantly
    setIsRecording(false)

    return new Promise((resolve) => {
      rec.onstop = () => {
        const mime =
          rec.mimeType ||
          (kind === 'audio' ? pickAudioMime() : pickVideoMime())
          
        const blob = new Blob(chunksRef.current, { type: mime })
        
        // Clear references AFTER the blob is safely created
        chunksRef.current = []
        recorderRef.current = null
        kindRef.current = null
        
        stream?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setPreviewStream(null)

        if (!blob.size) {
          resolve(null)
          return
        }
        if (isMediaTooLarge(blob.size)) {
          setError(MEDIA_TOO_LARGE_CODE)
          resolve(null)
          return
        }
        
        resolve({ blob, mimeType: mime })
      }

      try {
        if (rec.state !== 'inactive') {
          rec.requestData?.()
          rec.stop()
        }
      } catch {
        resolve(null)
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
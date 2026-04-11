'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/mp4'
  if (MediaRecorder.isTypeSupported('audio/mp4')) {
    return 'audio/mp4'
  }
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus'
  }
  if (MediaRecorder.isTypeSupported('audio/webm')) {
    return 'audio/webm'
  }
  return 'audio/mp4'
}

function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/mp4'
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    return 'video/mp4'
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
    return 'video/webm;codecs=vp9'
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
    return 'video/webm;codecs=vp8'
  }
  if (MediaRecorder.isTypeSupported('video/webm')) {
    return 'video/webm'
  }
  return 'video/mp4'
}


/**
 * MediaRecorder capture: prefers MP4 on Safari iOS; circle UX for video in UI.
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
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia(
        getUserMediaConstraints({ video: false })
      )
      streamRef.current = stream
      setPreviewStream(stream)
      kindRef.current = 'audio'
      const mime = pickAudioMime()
      const rec = (() => {
        try {
          return new MediaRecorder(stream, { mimeType: mime })
        } catch {
          return new MediaRecorder(stream)
        }
      })()
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.start()
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
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        setError(MEDIA_ACCESS_ERROR_MESSAGE)
        return
      }
      const base = getUserMediaConstraints({ video: true })
      const fromPrefs: MediaTrackConstraints =
        base.video && typeof base.video === 'object'
          ? (base.video as MediaTrackConstraints)
          : {}
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: base.audio,
        video: {
          ...fromPrefs,
          facingMode: 'user',
          width: { ideal: 720 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 1 },
        },
      })
      streamRef.current = stream
      setPreviewStream(stream)
      kindRef.current = 'video'
      const mime = pickVideoMime()
      const rec = (() => {
        try {
          return new MediaRecorder(stream, { mimeType: mime })
        } catch {
          return new MediaRecorder(stream)
        }
      })()
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.start()
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

    return new Promise((resolve) => {
      rec.onstop = () => {
        const mime =
          rec.mimeType ||
          (kind === 'audio' ? pickAudioMime() : pickVideoMime())
        const blob = new Blob(chunksRef.current, { type: mime })
        chunksRef.current = []
        recorderRef.current = null
        kindRef.current = null
        stream?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setPreviewStream(null)
        setIsRecording(false)
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
      rec.stop()
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

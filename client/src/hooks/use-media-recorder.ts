'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isMediaTooLarge, MEDIA_TOO_LARGE_CODE } from '@/lib/media-limits'

export type CaptureResult = {
  blob: Blob
  mimeType: string
}

function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus'
  }
  return 'audio/webm'
}

function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/webm'
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
    return 'video/webm;codecs=vp9'
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
    return 'video/webm;codecs=vp8'
  }
  return 'video/webm'
}

/**
 * MediaRecorder capture: audio/webm and square-ish video/webm (circle UX in UI).
 */
export function useMediaRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const kindRef = useRef<'audio' | 'video' | null>(null)

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const startVoiceCapture = useCallback(async () => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      kindRef.current = 'audio'
      const mime = pickAudioMime()
      const rec = new MediaRecorder(stream, { mimeType: mime })
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.start()
      setIsRecording(true)
    } catch {
      setError('MIC_DENIED')
    }
  }, [])

  const startVideoCircleCapture = useCallback(async () => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      chunksRef.current = []
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'user',
          width: { ideal: 720 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 1 },
        },
      })
      streamRef.current = stream
      kindRef.current = 'video'
      const mime = pickVideoMime()
      const rec = new MediaRecorder(stream, { mimeType: mime })
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.start()
      setIsRecording(true)
    } catch {
      setError('CAM_DENIED')
    }
  }, [])

  const stopCapture = useCallback(async (): Promise<CaptureResult | null> => {
    const rec = recorderRef.current
    const stream = streamRef.current
    const kind = kindRef.current

    if (!rec || rec.state === 'inactive') {
      setIsRecording(false)
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

  return {
    isRecording,
    error,
    clearError,
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream: streamRef.current,
  }
}

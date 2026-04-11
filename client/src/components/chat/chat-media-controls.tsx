'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { resumeAudioContextAfterGesture } from '@/lib/call-ringtones'
import {
  isMediaTooLarge,
  MAX_FILE_SIZE_LABEL,
  MEDIA_PERMISSION_DENIED_CODE,
  MEDIA_TOO_LARGE_CODE,
} from '@/lib/media-limits'
import { useTranslation } from '@/hooks/use-translation'

type SendMediaFn = (
  blob: Blob,
  mediaType: 'audio' | 'video' | 'image' | 'file',
  caption?: string,
  options?: { fileName?: string; fileType?: string }
) => Promise<void>

type Props = {
  cryptoCtx: ChatCryptoContext | null
  sendMedia: SendMediaFn
  disabled?: boolean
}

function useAudioAnalyser(isRecording: boolean) {
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!isRecording) {
      setLevel(0)
      return
    }
    let raf = 0
    const tick = () => {
      const a = analyserRef.current
      if (!a) return
      const data = new Uint8Array(a.frequencyBinCount)
      a.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      setLevel(Math.sqrt(sum / data.length))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isRecording])

  const connectStream = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      ctxRef.current = ctx
      analyserRef.current = analyser
    } catch {
      /* fallback: no waveform */
    }
  }, [])

  const disconnect = useCallback(() => {
    try {
      ctxRef.current?.close()
    } catch {
      /* ignore */
    }
    ctxRef.current = null
    analyserRef.current = null
    setLevel(0)
  }, [])

  return { level, connectStream, disconnect }
}

export function ChatMediaControls({ cryptoCtx, sendMedia, disabled }: Props) {
  const { t } = useTranslation()
  const {
    isRecording,
    error,
    clearError,
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream,
    getStream,
  } = useMediaRecorder()

  const { level, connectStream, disconnect } = useAudioAnalyser(isRecording)

  const modeRef = useRef<'voice' | 'video' | null>(null)
  const busyRef = useRef(false)
  const [mode, setMode] = useState<'voice' | 'video' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)
  const [cancelled, setCancelled] = useState(false)
  const startXRef = useRef(0)
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null)
  /** Debounce touch + pointer duplicate starts on iOS (same gesture fires both). */
  const lastVoiceGestureAt = useRef(0)
  const lastVideoGestureAt = useRef(0)
  const [banner, setBanner] = useState(false)

  useEffect(() => {
    if (!banner) return
    const id = window.setTimeout(() => setBanner(false), 4000)
    return () => window.clearTimeout(id)
  }, [banner])

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 200)
    return () => clearInterval(id)
  }, [isRecording])

  useEffect(() => {
    const el = videoPreviewRef.current
    if (previewStream && el) {
      el.srcObject = previewStream
      void el.play().catch(() => {
        /* iOS may defer play until layer ready */
      })
    }
    return () => {
      if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null
    }
  }, [previewStream])

  async function finish(sendIt: boolean) {
    if (busyRef.current) return
    const currentMode = modeRef.current
    if (!currentMode) return
    busyRef.current = true
    disconnect()
    try {
      modeRef.current = null
      setMode(null)
      setCancelled(false)
      const r = await stopCapture()
      if (!r || !cryptoCtx || !sendIt) return
      try {
        if (isMediaTooLarge(r.blob.size)) {
          setBanner(true)
          return
        }
        await sendMedia(r.blob, currentMode === 'voice' ? 'audio' : 'video')
      } catch {
        setBanner(true)
      }
    } finally {
      busyRef.current = false
    }
  }

  const fmtElapsed = `${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor((elapsed / 1000) % 60)).padStart(2, '0')}`

  const showRecorderError =
    error &&
    error !== MEDIA_TOO_LARGE_CODE &&
    error !== MEDIA_PERMISSION_DENIED_CODE &&
    error.length > 0

  return (
    <div className="pb-safe shrink-0 border-t border-neon-cyan/30 bg-black px-2 pt-2">
      {isRecording && mode ? (
        <div className="mb-2 space-y-2">
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
            <span className="animate-pulse text-neon-red">REC :: {mode}</span>
            <span className="tabular-nums text-red-800">{fmtElapsed}</span>
            {cancelled ? (
              <span className="text-neon-cyan">SLIDE_RELEASE_TO_CANCEL</span>
            ) : null}
          </div>
          {mode === 'voice' ? (
            <div className="flex h-6 items-end gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => {
                const h = Math.max(
                  4,
                  Math.min(
                    24,
                    level * 120 + Math.sin(i * 0.8 + elapsed * 0.01) * 4
                  )
                )
                return (
                  <div
                    key={i}
                    className="w-1 rounded-none bg-neon-red transition-all duration-75"
                    style={{ height: `${h}px` }}
                  />
                )
              })}
            </div>
          ) : null}
          {mode === 'video' && previewStream ? (
            <div className="mx-auto h-32 w-32 overflow-hidden rounded-full border-2 border-neon-red shadow-[0_0_16px_rgba(255,0,0,0.4)]">
              <video
                ref={videoPreviewRef}
                autoPlay
                playsInline
                muted
                controls={false}
                className="h-full w-full object-cover"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {!isRecording ? (
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
          <span>:: CAPTURE</span>
        </div>
      ) : null}
      {banner ? (
        <p className="mb-1 font-mono text-[10px] text-zinc-500">ERROR</p>
      ) : null}
      {error === MEDIA_PERMISSION_DENIED_CODE ? (
        <p className="mb-1 font-mono text-[10px] leading-snug text-neon-red">
          {t('media.permissionDenied')}
        </p>
      ) : null}
      {showRecorderError ? (
        <p className="mb-1 font-mono text-[10px] text-zinc-500">SIGNAL LOST</p>
      ) : null}
      {error === MEDIA_TOO_LARGE_CODE ? (
        <p className="mb-1 font-mono text-[10px] text-zinc-500">ERROR</p>
      ) : null}
      {!isRecording ? (
        <p className="mb-1 font-mono text-[10px] text-red-800">
          :: MAX_MEDIA_SIZE {MAX_FILE_SIZE_LABEL}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || !cryptoCtx || isRecording}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            const now = Date.now()
            if (now - lastVoiceGestureAt.current < 450) return
            lastVoiceGestureAt.current = now
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              /* ignore */
            }
            startXRef.current = e.clientX
            setCancelled(false)
            modeRef.current = 'voice'
            setMode('voice')
            void startVoiceCapture().then(() => {
              void resumeAudioContextAfterGesture()
              const stream = getStream()
              if (stream) connectStream(stream)
            })
          }}
          onTouchStart={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            const now = Date.now()
            if (now - lastVoiceGestureAt.current < 450) return
            lastVoiceGestureAt.current = now
            const t = e.touches[0]
            if (!t) return
            startXRef.current = t.clientX
            setCancelled(false)
            modeRef.current = 'voice'
            setMode('voice')
            void startVoiceCapture().then(() => {
              void resumeAudioContextAfterGesture()
              const stream = getStream()
              if (stream) connectStream(stream)
            })
          }}
          onPointerMove={(e) => {
            if (modeRef.current !== 'voice') return
            setCancelled(e.clientX < startXRef.current - 80)
          }}
          onTouchMove={(e) => {
            if (modeRef.current !== 'voice') return
            const t = e.touches[0]
            if (!t) return
            setCancelled(t.clientX < startXRef.current - 80)
          }}
          onPointerUp={() => void finish(!cancelled)}
          onPointerCancel={() => void finish(false)}
          onTouchEnd={() => void finish(!cancelled)}
          onTouchCancel={() => void finish(false)}
          className="touch-manipulation flex min-h-11 min-w-[44px] items-center justify-center rounded-none border border-neon-cyan bg-black px-4 py-3 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40 md:min-h-9 md:px-3 md:py-2"
        >
          {isRecording && mode === 'voice' ? '[ ● REC ]' : '[ HOLD :: VOICE ]'}
        </button>
        <button
          type="button"
          disabled={disabled || !cryptoCtx}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            const now = Date.now()
            if (now - lastVideoGestureAt.current < 450) return
            lastVideoGestureAt.current = now
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              /* ignore */
            }
            startXRef.current = e.clientX
            setCancelled(false)
            modeRef.current = 'video'
            setMode('video')
            void startVideoCircleCapture().then(() => {
              void resumeAudioContextAfterGesture()
            })
          }}
          onTouchStart={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            const now = Date.now()
            if (now - lastVideoGestureAt.current < 450) return
            lastVideoGestureAt.current = now
            const t = e.touches[0]
            if (!t) return
            startXRef.current = t.clientX
            setCancelled(false)
            modeRef.current = 'video'
            setMode('video')
            void startVideoCircleCapture().then(() => {
              void resumeAudioContextAfterGesture()
            })
          }}
          onPointerMove={(e) => {
            if (modeRef.current !== 'video') return
            setCancelled(e.clientX < startXRef.current - 80)
          }}
          onTouchMove={(e) => {
            if (modeRef.current !== 'video') return
            const t = e.touches[0]
            if (!t) return
            setCancelled(t.clientX < startXRef.current - 80)
          }}
          onPointerUp={() => void finish(!cancelled)}
          onPointerCancel={() => void finish(false)}
          onTouchEnd={() => void finish(!cancelled)}
          onTouchCancel={() => void finish(false)}
          className="touch-manipulation flex min-h-11 min-w-[44px] items-center justify-center rounded-none border border-neon-red bg-black px-4 py-3 font-mono text-xs uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40 md:min-h-9 md:px-3 md:py-2"
        >
          {isRecording && mode === 'video' ? '[ ● REC ]' : '[ HOLD :: CIRCLE ]'}
        </button>
        {showRecorderError ? (
          <button
            type="button"
            onClick={() => clearError()}
            className="font-mono text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            [X]
          </button>
        ) : null}
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { useSendMediaMessage } from '@/hooks/use-send-media-message'

type Props = {
  cryptoCtx: ChatCryptoContext | null
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

export function ChatMediaControls({ cryptoCtx, disabled }: Props) {
  const { sendMedia } = useSendMediaMessage(cryptoCtx)
  const {
    isRecording,
    error,
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream,
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
    if (previewStream && videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = previewStream
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
      await sendMedia(r.blob, currentMode === 'voice' ? 'audio' : 'video')
    } finally {
      busyRef.current = false
    }
  }

  const fmtElapsed = `${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor((elapsed / 1000) % 60)).padStart(2, '0')}`

  return (
    <div className="shrink-0 border-t border-neon-cyan/30 bg-black px-2 py-2">
      {isRecording && mode ? (
        <div className="mb-2 space-y-2">
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
            <span className="animate-pulse text-neon-red">
              REC :: {mode}
            </span>
            <span className="tabular-nums text-red-800">{fmtElapsed}</span>
            {cancelled ? (
              <span className="text-neon-cyan">SLIDE_RELEASE_TO_CANCEL</span>
            ) : null}
          </div>
          {mode === 'voice' ? (
            <div className="flex h-6 items-end gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => {
                const h = Math.max(4, Math.min(24, level * 120 + Math.sin(i * 0.8 + elapsed * 0.01) * 4))
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
                className="h-full w-full object-cover"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {!isRecording ? (
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
          <span>:: MEDIA</span>
        </div>
      ) : null}
      {error ? (
        <p className="mb-1 font-mono text-[10px] text-neon-red">[!] {error}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || !cryptoCtx}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.currentTarget.setPointerCapture(e.pointerId)
            startXRef.current = e.clientX
            setCancelled(false)
            modeRef.current = 'voice'
            setMode('voice')
            void startVoiceCapture().then(() => {
              const mr = (window as unknown as { __p13_last_stream?: MediaStream }).__p13_last_stream
              if (mr) connectStream(mr)
            })
          }}
          onPointerMove={(e) => {
            if (modeRef.current !== 'voice') return
            setCancelled(e.clientX < startXRef.current - 80)
          }}
          onPointerUp={() => void finish(!cancelled)}
          onPointerCancel={() => void finish(false)}
          className="rounded-none border border-neon-cyan bg-black px-3 py-2 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
        >
          {isRecording && mode === 'voice' ? '[ ● REC ]' : '[ HOLD :: VOICE ]'}
        </button>
        <button
          type="button"
          disabled={disabled || !cryptoCtx}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.currentTarget.setPointerCapture(e.pointerId)
            startXRef.current = e.clientX
            setCancelled(false)
            modeRef.current = 'video'
            setMode('video')
            void startVideoCircleCapture()
          }}
          onPointerMove={(e) => {
            if (modeRef.current !== 'video') return
            setCancelled(e.clientX < startXRef.current - 80)
          }}
          onPointerUp={() => void finish(!cancelled)}
          onPointerCancel={() => void finish(false)}
          className="rounded-none border border-neon-red bg-black px-3 py-2 font-mono text-xs uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40"
        >
          {isRecording && mode === 'video' ? '[ ● REC ]' : '[ HOLD :: CIRCLE ]'}
        </button>
      </div>
    </div>
  )
}

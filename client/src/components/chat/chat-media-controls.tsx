'use client'

import { useRef, useState } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { useSendMediaMessage } from '@/hooks/use-send-media-message'

type Props = {
  cryptoCtx: ChatCryptoContext | null
  disabled?: boolean
}

export function ChatMediaControls({ cryptoCtx, disabled }: Props) {
  const { sendMedia } = useSendMediaMessage(cryptoCtx)
  const {
    isRecording,
    error,
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
  } = useMediaRecorder()

  const modeRef = useRef<'voice' | 'video' | null>(null)
  const busyRef = useRef(false)
  const [mode, setMode] = useState<'voice' | 'video' | null>(null)

  async function finishVoice() {
    if (busyRef.current) return
    if (modeRef.current !== 'voice') return
    busyRef.current = true
    try {
      modeRef.current = null
      setMode(null)
      const r = await stopCapture()
      if (!r || !cryptoCtx) return
      await sendMedia(r.blob, 'audio')
    } finally {
      busyRef.current = false
    }
  }

  async function finishVideo() {
    if (busyRef.current) return
    if (modeRef.current !== 'video') return
    busyRef.current = true
    try {
      modeRef.current = null
      setMode(null)
      const r = await stopCapture()
      if (!r || !cryptoCtx) return
      await sendMedia(r.blob, 'video')
    } finally {
      busyRef.current = false
    }
  }

  return (
    <div className="shrink-0 border-t border-neon-cyan/30 bg-black px-2 py-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
        <span>:: MEDIA</span>
        {isRecording && mode ? (
          <span className="animate-pulse text-neon-red">REC :: {mode}</span>
        ) : null}
        {error ? (
          <span className="text-neon-red">[!] {error}</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || !cryptoCtx}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.currentTarget.setPointerCapture(e.pointerId)
            modeRef.current = 'voice'
            setMode('voice')
            void startVoiceCapture()
          }}
          onPointerUp={() => {
            void finishVoice()
          }}
          onPointerCancel={() => {
            void finishVoice()
          }}
          className="rounded-none border border-neon-cyan bg-black px-3 py-2 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
        >
          [ HOLD :: VOICE ]
        </button>
        <button
          type="button"
          disabled={disabled || !cryptoCtx}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.currentTarget.setPointerCapture(e.pointerId)
            modeRef.current = 'video'
            setMode('video')
            void startVideoCircleCapture()
          }}
          onPointerUp={() => {
            void finishVideo()
          }}
          onPointerCancel={() => {
            void finishVideo()
          }}
          className="rounded-none border border-neon-red bg-black px-3 py-2 font-mono text-xs uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40"
        >
          [ HOLD :: CIRCLE ]
        </button>
      </div>
    </div>
  )
}

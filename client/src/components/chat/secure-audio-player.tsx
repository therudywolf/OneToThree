'use client'

import { useEffect, useRef, useState } from 'react'

type Props = {
  mediaPath: string
  mediaIv: string
  mimeType: string
  sharedKey: CryptoKey | null
}

export function SecureAudioPlayer({
  mediaPath,
  mediaIv,
  mimeType,
  sharedKey,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    void mediaPath
    void mediaIv
    void mimeType
    if (!sharedKey) return
    setLoadErr('STORAGE_BACKEND_PENDING')
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setObjectUrl(null)
    }
  }, [mediaPath, mediaIv, mimeType, sharedKey])

  function togglePlay() {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
    } else {
      void el.play()
    }
  }

  if (loadErr) {
    return (
      <p className="font-mono text-[10px] text-neon-red">[!] {loadErr}</p>
    )
  }

  if (!sharedKey || !objectUrl) {
    return (
      <p className="font-mono text-[10px] text-red-800">LOADING_CIPHER…</p>
    )
  }

  return (
    <div className="mt-2 max-w-md rounded-none border border-neon-cyan bg-black p-2">
      <audio
        ref={audioRef}
        src={objectUrl}
        preload="auto"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setProgress(0)
        }}
        onTimeUpdate={() => {
          const el = audioRef.current
          if (!el?.duration) return
          setProgress((el.currentTime / el.duration) * 100)
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded-none border border-neon-red bg-black px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
        >
          {playing ? '||' : '>'}
        </button>
        <div className="h-2 flex-1 rounded-none bg-red-950">
          <div
            className="h-full rounded-none bg-neon-red"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  )
}

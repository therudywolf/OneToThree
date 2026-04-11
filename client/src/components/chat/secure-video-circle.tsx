'use client'

import { useEffect, useRef, useState } from 'react'

type Props = {
  mediaPath: string
  mediaIv: string
  mimeType: string
  sharedKey: CryptoKey | null
}

export function SecureVideoCircle({
  mediaPath,
  mediaIv,
  mimeType,
  sharedKey,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
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
    const el = videoRef.current
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
    <div className="mt-2 inline-block">
      <div className="relative h-48 w-48 overflow-hidden rounded-full border-2 border-neon-red bg-black shadow-[0_0_16px_rgba(0,255,255,0.35)]">
        <video
          ref={videoRef}
          src={objectUrl}
          preload="auto"
          playsInline
          muted
          autoPlay={false}
          className="h-full w-full object-cover"
          controls={false}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setProgress(0)
          }}
          onTimeUpdate={() => {
            const el = videoRef.current
            if (!el?.duration) return
            setProgress((el.currentTime / el.duration) * 100)
          }}
        />
        <button
          type="button"
          onClick={togglePlay}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-none border border-neon-cyan bg-black/80 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:text-neon-red"
        >
          {playing ? '||' : '>'}
        </button>
      </div>
      <div className="mt-2 h-2 w-48 rounded-none bg-red-950">
        <div
          className="h-full rounded-none bg-neon-red"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}

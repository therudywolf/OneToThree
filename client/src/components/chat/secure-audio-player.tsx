'use client'

import { useEffect, useRef, useState } from 'react'
import { decryptBlob } from '@/lib/crypto'
import { getS3ObjectUrl } from '@/lib/s3-urls'

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
    if (!sharedKey || !mediaPath || !mediaIv) {
      setLoadErr('MISSING_KEY_OR_DATA')
      return
    }

    let isSubscribed = true
    setLoadErr(null)

    const runDecryption = async () => {
      try {
        const s3Url = await getS3ObjectUrl(mediaPath)
        const res = await fetch(s3Url)
        if (!res.ok) throw new Error('FETCH_FAILED')
        const encryptedBuf = await res.arrayBuffer()

        const decryptedBlob = await decryptBlob(
          encryptedBuf,
          sharedKey,
          mediaIv,
          mimeType || 'audio/webm'
        )

        if (isSubscribed) {
          const url = URL.createObjectURL(decryptedBlob)
          blobUrlRef.current = url
          setObjectUrl(url)
        }
      } catch (error) {
        console.error('Audio decryption error:', error)
        if (isSubscribed) setLoadErr('DECRYPTION_FAILED')
      }
    }

    void runDecryption()

    return () => {
      isSubscribed = false
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
      <div className="mt-2 max-w-md rounded-none border border-neon-cyan/50 bg-black p-2">
         <p className="animate-pulse font-mono text-[10px] text-neon-cyan">DECRYPTING_AUDIO...</p>
      </div>
    )
  }

  return (
    <div className="mt-2 max-w-md rounded-none border border-neon-cyan bg-black p-2 shadow-[0_0_10px_rgba(0,255,255,0.05)]">
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
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-none border border-neon-cyan bg-black font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan hover:text-black transition-colors"
        >
          {playing ? '||' : '▶'}
        </button>
        <div className="h-1.5 flex-1 rounded-none bg-zinc-900 overflow-hidden">
          <div
            className="h-full rounded-none bg-neon-cyan transition-all duration-100 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  )
}
'use client'

import { useEffect, useRef, useState } from 'react'
import { decryptBinary } from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'

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
    if (!sharedKey || !mediaPath || !mediaIv) {
      setLoadErr('MISSING_KEY_OR_DATA')
      return
    }

    let isSubscribed = true
    setLoadErr(null)

    const runDecryption = async () => {
      try {
        const s3Url = await getDownloadUrl(mediaPath)
        const res = await fetch(s3Url)
        if (!res.ok) throw new Error('FETCH_FAILED')
        const encryptedBuf = await res.arrayBuffer()

        const decryptedBuf = await decryptBinary(sharedKey, encryptedBuf, mediaIv)
        // Strip codec params (e.g. "video/webm;codecs=vp8,opus" → "video/webm")
        const blobMime = (mimeType || 'video/webm').split(';')[0]
        const decryptedBlob = new Blob([decryptedBuf], { type: blobMime })

        if (isSubscribed) {
          const url = URL.createObjectURL(decryptedBlob)
          blobUrlRef.current = url
          setObjectUrl(url)
        }
      } catch (error) {
        console.error('VideoCircle decryption error:', error)
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
      <div className="relative flex h-48 w-48 items-center justify-center rounded-full border-2 border-neon-cyan bg-void">
        <p className="animate-pulse font-mono text-[10px] text-neon-cyan">LOADING...</p>
      </div>
    )
  }

  return (
    <div className="mt-2 inline-block">
      {/* The aspect-square and rounded-full classes force the video to be a circle. 
        object-cover ensures it fills the circle without stretching.
      */}
      <div className="relative aspect-square w-48 overflow-hidden rounded-full border-2 border-neon-cyan bg-void shadow-[0_0_16px_rgba(0,255,255,0.15)] group">
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
          className="absolute inset-0 m-auto flex h-12 w-12 items-center justify-center rounded-full bg-void/60 text-neon-cyan opacity-100 backdrop-blur-sm transition-opacity hover:bg-neon-cyan hover:text-text-primary group-hover:opacity-100"
        >
          {playing ? '||' : '▶'}
        </button>
      </div>
      <div className="mt-3 h-1 w-48 overflow-hidden bg-void">
        <div
          className="h-full bg-neon-cyan transition-all duration-100 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
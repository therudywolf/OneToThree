'use client'

import { useEffect, useRef, useState } from 'react'
import { decryptBinary } from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'
import type { DecryptedMessage } from '@/types/chat'

function mimeFromPathAndType(
  mediaPath: string,
  mediaType: DecryptedMessage['media_type']
): string {
  const p = mediaPath.toLowerCase()
  if (p.endsWith('.webm')) {
    return mediaType === 'audio' ? 'audio/webm' : 'video/webm'
  }
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif')) return 'image/gif'
  if (mediaType === 'audio') return 'audio/webm'
  if (mediaType === 'video') return 'video/webm'
  if (mediaType === 'image') return 'image/jpeg'
  return 'application/octet-stream'
}

type Props = {
  message: Pick<
    DecryptedMessage,
    'media_path' | 'media_iv' | 'media_type'
  > & { id: string }
  sharedKey: CryptoKey | null
}

export function MediaMessage({ message, sharedKey }: Props) {
  const mediaPath = message.media_path
  const mediaIv = message.media_iv
  const mediaType = message.media_type

  const blobUrlRef = useRef<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!mediaPath || !mediaIv || !sharedKey) {
      setObjectUrl(null)
      return
    }

    let cancelled = false
    ;(async () => {
      setLoadErr(null)
      setObjectUrl(null)
      try {
        const downloadUrl = await getDownloadUrl(mediaPath)
        const res = await fetch(downloadUrl)
        if (!res.ok) throw new Error('FETCH_MEDIA_FAILED')
        const cipher = await res.arrayBuffer()
        const plain = await decryptBinary(sharedKey, cipher, mediaIv)
        const mime = mimeFromPathAndType(mediaPath, mediaType)
        const blob = new Blob([plain], { type: mime })
        const url = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        blobUrlRef.current = url
        setObjectUrl(url)
      } catch (e) {
        if (!cancelled) {
          setLoadErr(e instanceof Error ? e.message : 'MEDIA_LOAD_FAIL')
        }
      }
    })()

    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setObjectUrl(null)
    }
  }, [mediaPath, mediaIv, sharedKey, mediaType, message.id])

  if (!mediaPath || !mediaIv) {
    return null
  }

  if (!sharedKey) {
    return (
      <p className="mt-2 font-mono text-[10px] text-red-800">
        NO_SESSION_KEY
      </p>
    )
  }

  if (loadErr) {
    return (
      <p className="mt-2 font-mono text-[10px] text-neon-red">[!] {loadErr}</p>
    )
  }

  if (!objectUrl) {
    return (
      <p className="mt-2 font-mono text-[10px] text-red-800">
        DECRYPTING_MEDIA…
      </p>
    )
  }

  const mime = mimeFromPathAndType(mediaPath, mediaType)

  if (mediaType === 'image' || mime.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={objectUrl}
        alt=""
        className="mt-2 max-h-64 max-w-full border border-neon-cyan/40 object-contain"
      />
    )
  }

  if (mediaType === 'audio' || mime.startsWith('audio/')) {
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
            onClick={() => {
              const el = audioRef.current
              if (!el) return
              if (playing) el.pause()
              else void el.play()
            }}
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

  return (
    <div className="mt-2 max-w-md border border-neon-cyan/40">
      <video
        ref={videoRef}
        src={objectUrl}
        className="aspect-video w-full bg-black object-cover"
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="flex items-center gap-2 border-t border-neon-cyan/30 p-2">
        <button
          type="button"
          onClick={() => {
            const el = videoRef.current
            if (!el) return
            if (playing) el.pause()
            else void el.play()
          }}
          className="rounded-none border border-neon-red bg-black px-3 py-1 font-mono text-[10px] uppercase text-neon-red"
        >
          {playing ? '||' : '>'}
        </button>
      </div>
    </div>
  )
}

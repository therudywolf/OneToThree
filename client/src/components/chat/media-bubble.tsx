'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decryptBinary } from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'
import {
  getCachedMedia,
  setCachedMedia,
} from '@/lib/media-cache'
import { useTranslation } from '@/hooks/use-translation'
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

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Deterministic bar heights for brutalist “waveform”. */
function barHeightsFromId(id: string, n: number): number[] {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    out.push(0.25 + (h % 75) / 100)
  }
  return out
}

type Props = {
  message: Pick<
    DecryptedMessage,
    'media_path' | 'media_iv' | 'media_type'
  > & { id: string }
  sharedKey: CryptoKey | null
}

export function MediaBubble({ message, sharedKey }: Props) {
  const { t } = useTranslation()
  const mediaPath = message.media_path
  const mediaIv = message.media_iv
  const mediaType = message.media_type

  const blobUrlRef = useRef<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  const barHeights = useMemo(() => barHeightsFromId(message.id, 28), [message.id])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const decrypt = useCallback(async () => {
    if (!mediaPath || !mediaIv || !sharedKey) return
    setLoadErr(null)
    setObjectUrl(null)
    try {
      const cached = await getCachedMedia(message.id)
      if (cached?.blob) {
        const url = URL.createObjectURL(cached.blob)
        blobUrlRef.current = url
        setObjectUrl(url)
        return
      }

      const downloadUrl = await getDownloadUrl(mediaPath)
      const res = await fetch(downloadUrl)
      if (res.status === 404 || res.status === 410) {
        throw new Error('FILE_EXPIRED')
      }
      if (!res.ok) throw new Error('FETCH_MEDIA_FAILED')
      const cipher = await res.arrayBuffer()
      const plain = await decryptBinary(sharedKey, cipher, mediaIv)
      const mime = mimeFromPathAndType(mediaPath, mediaType)
      const blob = new Blob([plain], { type: mime })
      await setCachedMedia(message.id, blob, mime)
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      setObjectUrl(url)
    } catch (e) {
      const code = e instanceof Error ? e.message : 'MEDIA_LOAD_FAIL'
      if (code === 'FILE_EXPIRED') {
        setLoadErr(t('media.fileExpiredServer'))
      } else {
        setLoadErr(code)
      }
    }
  }, [mediaPath, mediaIv, sharedKey, mediaType, message.id, t])

  useEffect(() => {
    if (!visible || !mediaPath || !mediaIv || !sharedKey) return
    void decrypt()
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setObjectUrl(null)
    }
  }, [visible, decrypt, mediaPath, mediaIv, sharedKey])

  if (!mediaPath || !mediaIv) return null

  if (!sharedKey) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-red-800">
        NO_SESSION_KEY
      </div>
    )
  }

  if (loadErr) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-neon-red">
        [!] {loadErr}
      </div>
    )
  }

  if (!objectUrl) {
    return (
      <div
        ref={sentinelRef}
        className="mt-2 animate-pulse font-mono text-[10px] text-red-800"
      >
        DECRYPTING_MEDIA…
      </div>
    )
  }

  const mime = mimeFromPathAndType(mediaPath, mediaType)

  if (mediaType === 'image' || mime.startsWith('image/')) {
    return (
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
            setCurrentSec(0)
          }}
          onLoadedMetadata={() => {
            const el = audioRef.current
            if (el?.duration) setDuration(el.duration)
          }}
          onTimeUpdate={() => {
            const el = audioRef.current
            if (!el?.duration) return
            setCurrentSec(el.currentTime)
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
            className="shrink-0 rounded-none border border-neon-red bg-black px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
          >
            {playing ? '||' : '>'}
          </button>
          <div className="flex h-8 flex-1 items-end gap-px">
            {barHeights.map((h, i) => (
              <div
                key={i}
                className="min-w-[2px] flex-1 rounded-[1px] bg-neon-cyan/30"
                style={{
                  height: `${Math.round(h * 100)}%`,
                  opacity: playing ? 0.45 + (i % 5) * 0.08 : 0.28,
                }}
              />
            ))}
          </div>
          <span className="shrink-0 font-mono text-[9px] tabular-nums text-neon-cyan/80">
            {formatTime(currentSec)} / {formatTime(duration)}
          </span>
        </div>
        <div className="mt-1 h-1 w-full rounded-none bg-red-950">
          <div
            className="h-full rounded-none bg-neon-red"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 max-w-xs border border-neon-cyan/40">
      <div className="mx-auto aspect-square w-full max-w-[240px] overflow-hidden rounded-full border-2 border-neon-cyan/50 bg-black shadow-[0_0_16px_rgba(0,255,255,0.12)]">
        <video
          ref={videoRef}
          src={objectUrl}
          className="h-full w-full object-cover"
          playsInline
          muted
          autoPlay
          loop
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>
      <div className="flex items-center gap-2 border-t border-neon-cyan/30 p-2">
        <button
          type="button"
          onClick={() => {
            const el = videoRef.current
            if (!el) return
            el.muted = false
            if (playing) el.pause()
            else void el.play()
          }}
          className="rounded-none border border-neon-red bg-black px-3 py-1 font-mono text-[10px] uppercase text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
        >
          {playing ? '||' : '> UNMUTE'}
        </button>
      </div>
    </div>
  )
}

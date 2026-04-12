'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  base64ToArrayBuffer,
  decryptBinary,
  importAesGcm256RawKey,
} from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'
import { getCachedMedia, setCachedMedia } from '@/lib/media-cache'
import { useTranslation } from '@/hooks/use-translation'
import { parseAttachmentEnvelope } from '@/lib/attachment-envelope'
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
  if (p.endsWith('.mp4')) return 'video/mp4'
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Props = {
  message: Pick<
    DecryptedMessage,
    'id' | 'media_path' | 'media_iv' | 'media_type'
  > & { plaintext?: string | null }
  sharedKey: CryptoKey | null
  onMediaClick?: (media: { id: string; url: string; type: 'image' | 'video'; mimeType: string }) => void
  onAudioEnd?: () => void
}

export function MediaBubble({ message, sharedKey, onMediaClick, onAudioEnd }: Props) {
  const { t } = useTranslation()
  const mediaPath = message.media_path
  const mediaIv = message.media_iv
  const mediaType = message.media_type

  const envelope = useMemo(
    () => parseAttachmentEnvelope(message.plaintext),
    [message.plaintext]
  )

  const effectiveMime = useMemo(() => {
    if (envelope?.mimeType) return envelope.mimeType
    return mimeFromPathAndType(mediaPath ?? '', mediaType)
  }, [envelope, mediaPath, mediaType])

  const blobUrlRef = useRef<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoNoteExpanded, setVideoNoteExpanded] = useState(false)
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
    setLoadErr(false)
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
        setLoadErr(true)
        return
      }
      if (!res.ok) {
        setLoadErr(true)
        return
      }
      const cipher = await res.arrayBuffer()
      let plain: ArrayBuffer

      if (envelope) {
        const wrapPlain = await decryptBinary(
          sharedKey,
          base64ToArrayBuffer(envelope.wrapCt),
          envelope.wrapIv
        )
        const fileKey = await importAesGcm256RawKey(wrapPlain, ['decrypt'])
        const fileIv = new Uint8Array(base64ToArrayBuffer(mediaIv))
        plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fileIv as BufferSource },
          fileKey,
          cipher as BufferSource
        )
      } else {
        plain = await decryptBinary(sharedKey, cipher, mediaIv)
      }

      const mime = envelope?.mimeType ?? mimeFromPathAndType(mediaPath, mediaType)
      const blob = new Blob([plain], { type: mime })
      await setCachedMedia(message.id, blob, mime)
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      setObjectUrl(url)
    } catch {
      setLoadErr(true)
    }
  }, [mediaPath, mediaIv, sharedKey, mediaType, message.id, envelope])

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
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-zinc-500">
        {t('errors.signalLost')}
      </div>
    )
  }

  if (loadErr) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-zinc-500">
        {t('errors.signalLost')}
      </div>
    )
  }

  if (!objectUrl) {
    return (
      <div
        ref={sentinelRef}
        className="mt-2 animate-pulse font-mono text-[10px] text-zinc-600"
      >
        {t('media.loading')}
      </div>
    )
  }

  const isImage =
    mediaType === 'image' || effectiveMime.startsWith('image/')
  const isAudio =
    mediaType === 'audio' || effectiveMime.startsWith('audio/')
  const isVideo =
    mediaType === 'video' || effectiveMime.startsWith('video/')
  const isFile =
    mediaType === 'file' ||
    (!isImage && !isAudio && !isVideo)

  const displayName = envelope?.fileName ?? mediaPath.split('/').pop() ?? 'FILE'
  const displaySize = envelope?.fileSize

  if (isImage) {
    return (
      <img
        src={objectUrl}
        alt=""
        className="mt-2 max-h-64 max-w-full cursor-pointer border border-neon-cyan/40 object-contain hover:border-neon-cyan/60"
        onClick={() => onMediaClick?.({
          id: message.id,
          url: objectUrl,
          type: 'image',
          mimeType: effectiveMime,
        })}
      />
    )
  }

  if (isAudio) {
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
            onAudioEnd?.()
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
          <button
            type="button"
            onClick={() => {
              const newSpeed = playbackSpeed === 1 ? 1.5 : playbackSpeed === 1.5 ? 2 : 1
              setPlaybackSpeed(newSpeed)
              if (audioRef.current) {
                audioRef.current.playbackRate = newSpeed
              }
            }}
            className="shrink-0 rounded-none border border-neon-cyan/50 bg-black px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:border-neon-red hover:text-neon-red"
          >
            {playbackSpeed}x
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

  if (isVideo) {
    const circleStyle =
      effectiveMime === 'video/webm' &&
      (displayName.toLowerCase().includes('video-') ||
        displayName.toLowerCase().endsWith('.webm'))

    if (circleStyle) {
      return (
        <div className="mt-2 max-w-xs border border-neon-cyan/40">
          <div
            className={`mx-auto w-full max-w-[240px] overflow-hidden rounded-full border-2 border-neon-cyan/50 bg-black shadow-[0_0_16px_rgba(0,255,255,0.12)] transition-transform duration-300 ${
              videoNoteExpanded ? 'scale-150' : 'scale-100'
            }`}
            onClick={() => setVideoNoteExpanded(!videoNoteExpanded)}
            style={{ cursor: 'pointer' }}
          >
            <video
              ref={videoRef}
              src={objectUrl}
              className="h-full w-full object-cover"
              playsInline
              muted
              autoPlay
              loop
              controls={false}
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

    return (
      <div className="mt-2 max-w-md border border-neon-cyan/40 bg-black">
        <video
          ref={videoRef}
          src={objectUrl}
          className="aspect-video w-full cursor-pointer bg-black object-contain"
          playsInline
          muted
          autoPlay={false}
          controls
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={() => onMediaClick?.({
            id: message.id,
            url: objectUrl,
            type: 'video',
            mimeType: effectiveMime,
          })}
        />
      </div>
    )
  }

  /* Generic file */
  return (
    <div className="mt-2 max-w-sm border-2 border-zinc-700 bg-zinc-950/80 p-3 font-mono">
      <div className="mb-2 text-[10px] uppercase tracking-[0.4em] text-zinc-500">
        :: file
      </div>
      <p className="mb-1 break-all text-xs text-zinc-300">{displayName}</p>
      {displaySize != null ? (
        <p className="mb-3 text-[10px] text-zinc-600">
          {formatFileSize(displaySize)}
        </p>
      ) : (
        <p className="mb-3 text-[10px] text-zinc-600">—</p>
      )}
      <a
        href={objectUrl}
        download={displayName}
        className="inline-block w-full border border-neon-cyan/60 bg-black py-2 text-center text-[10px] uppercase tracking-widest text-neon-cyan hover:border-neon-red hover:text-neon-red"
      >
        {t('media.download')}
      </a>
    </div>
  )
}

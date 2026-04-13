'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
import { SkipBack, SkipForward, FileText, Download } from 'lucide-react'

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
  onPrevVoice?: () => void
  onNextVoice?: () => void
}

export function MediaBubble({ message, sharedKey, onMediaClick, onAudioEnd, onPrevVoice, onNextVoice }: Props) {
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
        className="mt-2 animate-pulse font-mono text-[10px] text-neon-cyan/60"
      >
        [ DECRYPTING_MEDIA... ]
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
      <div className="mt-2 max-w-full overflow-hidden border border-neon-cyan/40 hover:border-neon-cyan/80 transition-colors cursor-pointer"
        style={{ maxHeight: '300px' }}
      >
        <img
          src={objectUrl}
          alt=""
          className="h-auto max-h-[300px] w-auto max-w-full object-contain"
          loading="lazy"
          onClick={() => onMediaClick?.({
            id: message.id,
            url: objectUrl,
            type: 'image',
            mimeType: effectiveMime,
          })}
          onLoad={(e) => {
            // Remove any placeholder after load
            const img = e.currentTarget
            img.style.opacity = '1'
          }}
          style={{ opacity: 1, transition: 'opacity 0.2s ease' }}
        />
      </div>
    )
  }

  if (isAudio) {
    return (
      <div className="mt-2 max-w-sm rounded-none border border-neon-cyan/40 bg-black p-2 shadow-[0_0_10px_rgba(0,255,255,0.05)]">
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none border border-neon-cyan bg-black font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-black"
          >
            {playing ? '||' : '▶'}
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
            className="flex h-7 w-8 shrink-0 items-center justify-center rounded-none border border-neon-cyan/30 bg-black font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:border-neon-red hover:text-neon-red"
          >
            {playbackSpeed}x
          </button>
          {onPrevVoice ? (
            <button
              type="button"
              onClick={onPrevVoice}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none border border-neon-cyan/20 bg-black text-neon-cyan/60 transition-colors hover:border-neon-cyan hover:text-neon-cyan"
              title={t('media.prevVoice')}
            >
              <SkipBack className="h-3 w-3" />
            </button>
          ) : null}
          {onNextVoice ? (
            <button
              type="button"
              onClick={onNextVoice}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none border border-neon-cyan/20 bg-black text-neon-cyan/60 transition-colors hover:border-neon-cyan hover:text-neon-cyan"
              title={t('media.nextVoice')}
            >
              <SkipForward className="h-3 w-3" />
            </button>
          ) : null}
          <div className="flex h-7 flex-1 items-end gap-[1px]">
            {barHeights.map((h, i) => (
              <div
                key={i}
                className="min-w-[2px] flex-1 rounded-[1px] bg-neon-cyan"
                style={{
                  height: `${Math.round(h * 100)}%`,
                  opacity: playing ? 0.6 + (i % 5) * 0.08 : 0.2,
                  transition: 'opacity 0.2s',
                }}
              />
            ))}
          </div>
          <span className="shrink-0 font-mono text-[9px] tabular-nums text-neon-cyan/70">
            {formatTime(currentSec)} / {formatTime(duration)}
          </span>
        </div>
        <div className="mt-2 h-[2px] w-full rounded-none bg-zinc-900 overflow-hidden">
          <div
            className="h-full rounded-none bg-neon-cyan transition-all duration-100 ease-linear"
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
      const expandedSize = 'min(65vw, 24rem)'
      const collapsedSize = '240px'

      return (
        <div className="mt-2 relative">
          {/* Click-outside overlay when expanded */}
          <AnimatePresence>
            {videoNoteExpanded && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] bg-black/60"
                onClick={() => setVideoNoteExpanded(false)}
              />
            )}
          </AnimatePresence>

          <motion.div
            layout
            animate={{
              width: videoNoteExpanded ? expandedSize : collapsedSize,
            }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={`relative rounded-sm border bg-black/40 p-2 ${
              videoNoteExpanded
                ? 'z-[90] border-neon-cyan/60 shadow-[0_0_30px_rgba(0,255,255,0.25)]'
                : 'border-neon-cyan/20'
            }`}
          >
            <motion.div
              layout
              className={`relative mx-auto aspect-square w-full overflow-hidden rounded-full border-2 transition-shadow duration-300 ${
                videoNoteExpanded
                  ? 'border-neon-cyan shadow-[0_0_24px_rgba(0,255,255,0.35)]'
                  : 'border-neon-cyan shadow-[0_0_15px_rgba(0,255,255,0.15)]'
              }`}
              onClick={() => setVideoNoteExpanded(!videoNoteExpanded)}
              style={{ cursor: 'pointer' }}
            >
              <video
                ref={videoRef}
                src={objectUrl}
                className="absolute inset-0 h-full w-full object-cover"
                playsInline
                muted
                autoPlay
                loop
                controls={false}
                preload="metadata"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={() => {
                  const el = videoRef.current
                  if (!el?.duration) return
                  setCurrentSec(el.currentTime)
                  setProgress((el.currentTime / el.duration) * 100)
                  if (!duration) setDuration(el.duration)
                }}
              />
            </motion.div>

            {/* Controls — always visible, expanded shows progress */}
            <div className="mt-3 flex flex-col gap-2 border-t border-neon-cyan/20 pt-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const el = videoRef.current
                    if (!el) return
                    el.muted = false
                    if (playing) el.pause()
                    else void el.play()
                  }}
                  className="flex h-6 items-center justify-center rounded-none border border-neon-red bg-black px-2 font-mono text-[9px] uppercase tracking-widest text-neon-red transition-colors hover:border-neon-cyan hover:bg-neon-cyan hover:text-black"
                >
                  {playing ? '|| PAUSE' : '\u25B6 UNMUTE'}
                </button>
                {videoNoteExpanded ? (
                  <span className="shrink-0 font-mono text-[9px] tabular-nums text-neon-cyan/70">
                    {formatTime(currentSec)} / {formatTime(duration)}
                  </span>
                ) : (
                  <span className="font-mono text-[9px] text-neon-cyan/50 tracking-widest">
                    CIRCLE_VID
                  </span>
                )}
              </div>
              {videoNoteExpanded ? (
                <div className="h-[2px] w-full rounded-none bg-zinc-900 overflow-hidden">
                  <div
                    className="h-full rounded-none bg-neon-cyan transition-all duration-100 ease-linear"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              ) : null}
            </div>
          </motion.div>
        </div>
      )
    }

    return (
      <div className="mt-2 max-w-md border border-neon-cyan/40 bg-black p-1">
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
  const ext = displayName.split('.').pop()?.toLowerCase() ?? ''
  return (
    <div className="mt-2 max-w-sm border border-zinc-700 bg-zinc-950/80 font-mono">
      <div className="flex items-center gap-3 p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neon-cyan/30 bg-black">
          <FileText className="h-5 w-5 text-neon-cyan/60" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-300">{displayName}</p>
          <div className="flex items-center gap-2 text-[10px] text-zinc-600">
            {ext ? <span className="uppercase">{ext}</span> : null}
            {displaySize != null ? (
              <span>{formatFileSize(displaySize)}</span>
            ) : null}
          </div>
        </div>
        <a
          href={objectUrl}
          download={displayName}
          className="flex h-8 w-8 shrink-0 items-center justify-center border border-neon-cyan/40 bg-black text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/10"
          title={t('media.download')}
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    </div>
  )
}
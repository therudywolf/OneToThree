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
import { classifyAttachment, parseAlbumEnvelope, parseAttachmentEnvelope } from '@/lib/attachment-envelope'
import type { DecryptedMessage } from '@/types/chat'
import { SkipBack, SkipForward, FileText, Download } from 'lucide-react'
import { AlbumBubble } from '@/components/chat/album-bubble'

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

/** Caption rendered below any media bubble */
function MediaCaption({ text }: { text: string }) {
  return (
    <p className="mt-1.5 font-mono text-[12px] leading-snug text-neon-cyan/80 break-words max-w-sm">
      {text}
    </p>
  )
}

export function MediaBubble({ message, sharedKey, onMediaClick, onAudioEnd, onPrevVoice, onNextVoice }: Props) {
  const { t } = useTranslation()
  const mediaPath = message.media_path
  const mediaIv = message.media_iv
  const mediaType = message.media_type

  const albumEnvelope = useMemo(
    () => parseAlbumEnvelope(message.plaintext),
    [message.plaintext]
  )

  const envelope = useMemo(
    () => (albumEnvelope ? null : parseAttachmentEnvelope(message.plaintext)),
    [albumEnvelope, message.plaintext]
  )

  const caption = envelope?.caption ?? null

  const effectiveMime = useMemo(() => {
    const raw = envelope?.mimeType ?? mimeFromPathAndType(mediaPath ?? '', mediaType)
    // Strip codec params for reliable browser playback
    return raw.split(';')[0]
  }, [envelope, mediaPath, mediaType])

  // Classify the attachment using explicit envelope.kind (v1.1+) with MIME / filename fallback
  // for legacy messages. This replaces the old "endsWith('.webm')" heuristic that
  // erroneously turned every WebM video into a circle preview.
  const attachmentKind = useMemo(
    () =>
      classifyAttachment({
        envelope,
        mediaType,
        mimeType: effectiveMime,
        fileName: envelope?.fileName ?? mediaPath ?? null,
      }),
    [envelope, mediaType, effectiveMime, mediaPath]
  )

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

  const isPublicMedia = mediaIv === 'public'

  const decrypt = useCallback(async () => {
    if (!mediaPath || !mediaIv) return
    if (!isPublicMedia && !sharedKey) return
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

      let plain: ArrayBuffer

      if (isPublicMedia) {
        plain = await res.arrayBuffer()
      } else {
        const cipher = await res.arrayBuffer()
        if (envelope) {
          const wrapPlain = await decryptBinary(
            sharedKey!,
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
          plain = await decryptBinary(sharedKey!, cipher, mediaIv)
        }
      }

      const rawMime = envelope?.mimeType ?? mimeFromPathAndType(mediaPath, mediaType)
      // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm")
      // to avoid browser playback issues with duration detection
      const mime = rawMime.split(';')[0]
      const blob = new Blob([plain], { type: mime })
      await setCachedMedia(message.id, blob, mime)
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      setObjectUrl(url)
    } catch {
      setLoadErr(true)
    }
  }, [mediaPath, mediaIv, sharedKey, mediaType, message.id, envelope, isPublicMedia])

  useEffect(() => {
    if (!visible || !mediaPath || !mediaIv) return
    if (!isPublicMedia && !sharedKey) return
    void decrypt()
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setObjectUrl(null)
    }
  }, [visible, decrypt, mediaPath, mediaIv, sharedKey, isPublicMedia])

  if (albumEnvelope) {
    return (
      <AlbumBubble
        messageId={message.id}
        envelope={albumEnvelope}
        sharedKey={sharedKey}
        onMediaClick={onMediaClick}
      />
    )
  }

  if (!mediaPath || !mediaIv) return null

  if (!sharedKey && !isPublicMedia) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-text-muted">
        {t('errors.signalLost')}
      </div>
    )
  }

  if (loadErr) {
    return (
      <div ref={sentinelRef} className="mt-2 font-mono text-[10px] text-text-muted">
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
  const _isFile =
    mediaType === 'file' ||
    (!isImage && !isAudio && !isVideo)

  const displayName = envelope?.fileName ?? mediaPath.split('/').pop() ?? 'FILE'
  const displaySize = envelope?.fileSize

  if (isImage) {
    return (
      <div>
        <div
          className="p13-media-card mt-2 max-w-full overflow-hidden hover:border-neon-cyan/80 transition-colors cursor-pointer"
          style={{ maxHeight: '300px', aspectRatio: '16/9', maxWidth: '300px' }}
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
              const img = e.currentTarget
              img.style.opacity = '1'
              const parent = img.parentElement
              if (parent && img.naturalWidth && img.naturalHeight) {
                parent.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`
              }
            }}
            style={{ opacity: 0.01, transition: 'opacity 0.2s ease' }}
          />
        </div>
        <div className="mt-2 flex justify-end">
          <a
            href={objectUrl}
            download={displayName}
            className="p13-media-action-btn flex h-8 items-center gap-1 px-2 font-mono text-[9px] uppercase tracking-widest"
          >
            <Download className="h-3 w-3" />
            {t('media.download')}
          </a>
        </div>
        {caption ? <MediaCaption text={caption} /> : null}
      </div>
    )
  }

  if (isAudio) {
    return (
      <div>
        <div className="p13-audio-card mt-2 max-w-sm rounded-none p-2">
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
              if (!el) return
              if (Number.isFinite(el.duration) && el.duration > 0) {
                setDuration(el.duration)
              } else {
                el.currentTime = 1e10
              }
            }}
            onDurationChange={() => {
              const el = audioRef.current
              if (!el) return
              if (Number.isFinite(el.duration) && el.duration > 0) {
                setDuration(el.duration)
                if (el.currentTime > el.duration) {
                  el.currentTime = 0
                }
              }
            }}
            onTimeUpdate={() => {
              const el = audioRef.current
              if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
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
              className="p13-media-action-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-none font-mono text-[10px] uppercase tracking-widest"
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
              className="p13-media-action-btn flex h-7 w-8 shrink-0 items-center justify-center rounded-none font-mono text-[9px] uppercase tracking-widest hover:border-neon-red hover:text-neon-red"
            >
              {playbackSpeed}x
            </button>
            {onPrevVoice ? (
              <button
                type="button"
                onClick={onPrevVoice}
                className="p13-media-action-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-none text-neon-cyan/60"
                title={t('media.prevVoice')}
              >
                <SkipBack className="h-3 w-3" />
              </button>
            ) : null}
            {onNextVoice ? (
              <button
                type="button"
                onClick={onNextVoice}
                className="p13-media-action-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-none text-neon-cyan/60"
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
            <a
              href={objectUrl}
              download={displayName}
            className="p13-media-action-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-none text-neon-cyan/70"
              title={t('media.download')}
            >
              <Download className="h-3 w-3" />
            </a>
          </div>
          <div className="mt-2 h-[2px] w-full rounded-none bg-void overflow-hidden">
            <div
              className="h-full rounded-none bg-neon-cyan transition-all duration-100 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        {caption ? <MediaCaption text={caption} /> : null}
      </div>
    )
  }

  if (isVideo) {
    // Render as a video-note circle only when the sender explicitly flagged it
    // (envelope.kind === 'video_circle') or when the legacy filename heuristic
    // matches. Generic uploaded WebM videos now render as normal video players.
    const circleStyle =
      attachmentKind === 'video_circle' ||
      (!envelope?.kind &&
        effectiveMime === 'video/webm' &&
        /^video-(note|circle)-/i.test(displayName))

    if (circleStyle) {
      const expandedSize = 'min(65vw, 24rem)'
      const collapsedSize = '240px'

      return (
        <div className="mt-2 relative">
          <AnimatePresence>
            {videoNoteExpanded && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] bg-void/60"
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
            className={`p13-video-card relative rounded-sm p-2 ${
              videoNoteExpanded
                ? 'z-[90] border-neon-cyan/60 shadow-[0_0_30px_rgba(0,255,255,0.25)]'
                : ''
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
                onLoadedMetadata={() => {
                  const el = videoRef.current
                  if (!el) return
                  if (Number.isFinite(el.duration) && el.duration > 0) {
                    setDuration(el.duration)
                  } else {
                    el.currentTime = 1e10
                  }
                }}
                onDurationChange={() => {
                  const el = videoRef.current
                  if (!el) return
                  if (Number.isFinite(el.duration) && el.duration > 0) {
                    setDuration(el.duration)
                    if (el.currentTime > el.duration) el.currentTime = 0
                  }
                }}
                onTimeUpdate={() => {
                  const el = videoRef.current
                  if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
                  setCurrentSec(el.currentTime)
                  setProgress((el.currentTime / el.duration) * 100)
                }}
              />
            </motion.div>

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
                  className="p13-media-action-btn flex h-6 items-center justify-center rounded-none px-2 font-mono text-[9px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:bg-neon-cyan hover:text-text-primary"
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
                <div className="h-[2px] w-full rounded-none bg-void overflow-hidden">
                  <div
                    className="h-full rounded-none bg-neon-cyan transition-all duration-100 ease-linear"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              ) : null}
            </div>
          </motion.div>
          {caption ? <MediaCaption text={caption} /> : null}
        </div>
      )
    }

    return (
      <div>
        <div className="p13-video-card mt-2 max-w-md p-1" style={{ aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            src={objectUrl}
            className="aspect-video w-full cursor-pointer bg-void object-contain"
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
        <div className="mt-2 flex justify-end">
          <a
            href={objectUrl}
            download={displayName}
            className="p13-media-action-btn flex h-8 items-center gap-1 px-2 font-mono text-[9px] uppercase tracking-widest"
          >
            <Download className="h-3 w-3" />
            {t('media.download')}
          </a>
        </div>
        {caption ? <MediaCaption text={caption} /> : null}
      </div>
    )
  }

  /* Generic file */
  const ext = displayName.split('.').pop()?.toLowerCase() ?? ''
  return (
    <div>
      <div className="p13-file-card mt-2 max-w-sm font-mono">
        <div className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neon-cyan/30 bg-void">
            <FileText className="h-5 w-5 text-neon-cyan/60" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-text-primary">{displayName}</p>
            <div className="flex items-center gap-2 text-[10px] text-text-muted/70">
              {ext ? <span className="uppercase">{ext}</span> : null}
              {displaySize != null ? (
                <span>{formatFileSize(displaySize)}</span>
              ) : null}
            </div>
          </div>
          <a
            href={objectUrl}
            download={displayName}
            className="p13-media-action-btn flex h-8 w-8 shrink-0 items-center justify-center text-neon-cyan"
            title={t('media.download')}
          >
            <Download className="h-4 w-4" />
          </a>
        </div>
      </div>
      {caption ? <MediaCaption text={caption} /> : null}
    </div>
  )
}

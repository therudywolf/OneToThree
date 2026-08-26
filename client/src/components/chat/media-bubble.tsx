'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  base64ToArrayBuffer,
  decryptBinary, decryptBinaryWithRing,
  importAesGcm256RawKey,
} from '@/lib/crypto'
import { getDownloadUrl, MediaEvictedError, postRestoreComplete, postRestoreUrl } from '@/lib/api/storage'
import { getCachedMedia, setCachedMedia } from '@/lib/media-cache'
import { MediaEvictedPlaceholder } from '@/components/chat/media-evicted-placeholder'
import { useTranslation } from '@/hooks/use-translation'
import { classifyAttachment, parseAlbumEnvelope, parseAttachmentEnvelope } from '@/lib/attachment-envelope'
import type { DecryptedMessage } from '@/types/chat'
import { SkipBack, SkipForward, FileText, Download, Maximize2 } from 'lucide-react'
import { AlbumBubble } from '@/components/chat/album-bubble'

async function encryptWithExistingIv(
  key: CryptoKey,
  plain: ArrayBuffer,
  ivBase64: string
): Promise<ArrayBuffer> {
  const iv = new Uint8Array(base64ToArrayBuffer(ivBase64))
  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plain as BufferSource
  )
}

async function putRestoredMedia(
  uploadUrl: string,
  mimeType: string,
  payload: ArrayBuffer
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: payload,
  })
  if (!res.ok) {
    throw new Error(`RESTORE_PUT_${res.status}`)
  }
}

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

/**
 * Server-eviction probe coalescing (D10).
 *
 * On a media-cache HIT we still want to know whether the *server* blob was
 * LRU-evicted (so we can surface the "restore" affordance), but presigning a
 * download URL for every cached bubble on every mount is wasteful — a chat full
 * of cached images would fire one presign request per bubble. We coalesce
 * probes per mediaPath: concurrent / rapidly-repeated probes for the same path
 * share a single in-flight request, and a successful "not evicted" result is
 * remembered for a short TTL so re-mounts (scroll in/out) don't re-probe.
 */
const EVICTION_PROBE_TTL_MS = 30_000
const evictionProbeCache = new Map<string, { evicted: boolean; at: number }>()
const evictionProbeInflight = new Map<string, Promise<boolean>>()

/** Returns true if the server reports the blob evicted. Coalesced per mediaPath. */
function probeServerEviction(mediaPath: string): Promise<boolean> {
  const cached = evictionProbeCache.get(mediaPath)
  if (cached && Date.now() - cached.at < EVICTION_PROBE_TTL_MS) {
    return Promise.resolve(cached.evicted)
  }
  const inflight = evictionProbeInflight.get(mediaPath)
  if (inflight) return inflight
  const p = getDownloadUrl(mediaPath)
    .then(() => {
      evictionProbeCache.set(mediaPath, { evicted: false, at: Date.now() })
      return false
    })
    .catch((err) => {
      if (err instanceof MediaEvictedError) {
        evictionProbeCache.set(mediaPath, { evicted: true, at: Date.now() })
        return true
      }
      // Transient/network error: don't cache, let a later probe retry.
      throw err
    })
    .finally(() => {
      evictionProbeInflight.delete(mediaPath)
    })
  evictionProbeInflight.set(mediaPath, p)
  return p
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
    <p className="p13-media-caption mt-1.5 text-[12px] leading-snug break-words max-w-sm">
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
  const [evicted, setEvicted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cachedBlobRef = useRef<Blob | null>(null)
  const [videoNoteExpanded, setVideoNoteExpanded] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [serverEvicted, setServerEvicted] = useState(false)
  const [restoring, setRestoring] = useState(false)

  // Prefer the real record-time waveform (envelope.waveform, 0–100 ints) when
  // present; fall back to the id-seeded pseudo-bars for legacy messages (#11).
  const barHeights = useMemo(() => {
    const wf = envelope?.waveform
    if (wf && wf.length > 0) {
      return wf.map((v) => Math.max(0.12, Math.min(1, v / 100)))
    }
    return barHeightsFromId(message.id, 28)
  }, [envelope?.waveform, message.id])
  // Duration captured at record time — authoritative for display/progress so the
  // length shows correctly on first paint (WebM `el.duration` is Infinity until a
  // seek-to-end hack). el.duration only refines it once known (#11).
  const envDurationSec =
    envelope?.durationMs && envelope.durationMs > 0 ? envelope.durationMs / 1000 : 0
  const shownDuration = duration > 0 ? duration : envDurationSec

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
    setEvicted(false)
    setServerEvicted(false)
    setObjectUrl(null)
    try {
      const cached = await getCachedMedia(message.id)
      if (cached?.blob) {
        cachedBlobRef.current = cached.blob
        const url = URL.createObjectURL(cached.blob)
        blobUrlRef.current = url
        setObjectUrl(url)
        // We already have the bytes locally, so the bubble is fully usable. The
        // server-eviction probe is only needed to decide whether to surface the
        // "restore to server" affordance — coalesce it per mediaPath so a screen
        // full of cached bubbles doesn't fire one presign per bubble (D10). A
        // transient probe failure is swallowed: the local copy still renders.
        try {
          if (await probeServerEviction(mediaPath)) {
            setServerEvicted(true)
          }
        } catch {
          // ignore — cached bytes are shown regardless
        }
        return
      }

      let downloadUrl: string
      try {
        downloadUrl = await getDownloadUrl(mediaPath)
      } catch (err) {
        // Sprint M1-4 — server-side LRU evicted the blob. We have no local
        // copy (cache lookup above returned nothing), so render placeholder.
        if (err instanceof MediaEvictedError) {
          setEvicted(true)
          return
        }
        throw err
      }
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
          plain = await decryptBinaryWithRing(sharedKey!, cipher, mediaIv)
        }
      }

      const rawMime = envelope?.mimeType ?? mimeFromPathAndType(mediaPath, mediaType)
      // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm")
      // to avoid browser playback issues with duration detection
      const mime = rawMime.split(';')[0]
      const blob = new Blob([plain], { type: mime })
      await setCachedMedia(message.id, blob, mime)
      cachedBlobRef.current = blob
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      setObjectUrl(url)
    } catch {
      setLoadErr(true)
    }
  }, [mediaPath, mediaIv, sharedKey, mediaType, message.id, envelope, isPublicMedia])

  const restoreToServer = useCallback(async () => {
    if (!mediaPath || !mediaIv || restoring) return
    const cachedBlob = cachedBlobRef.current
    if (!cachedBlob) return
    if (!isPublicMedia && !sharedKey) return
    setRestoring(true)
    setLoadErr(false)
    try {
      const plain = await cachedBlob.arrayBuffer()
      let payload: ArrayBuffer
      if (isPublicMedia) {
        payload = plain
      } else if (envelope) {
        const wrapPlain = await decryptBinary(
          sharedKey!,
          base64ToArrayBuffer(envelope.wrapCt),
          envelope.wrapIv
        )
        const fileKey = await importAesGcm256RawKey(wrapPlain, ['encrypt'])
        payload = await encryptWithExistingIv(fileKey, plain, mediaIv)
      } else {
        payload = await encryptWithExistingIv(sharedKey!, plain, mediaIv)
      }

      const restore = await postRestoreUrl({
        filePath: mediaPath,
        fileType: effectiveMime,
        fileSize: payload.byteLength,
      })
      // SigV4 signs the Content-Type, and the server may have neutralized it
      // (source/markup files are stored as opaque bytes) — send back what it
      // actually signed, not what the envelope says the file is.
      await putRestoredMedia(restore.uploadUrl, restore.contentType ?? effectiveMime, payload)
      await postRestoreComplete({
        filePath: mediaPath,
        fileType: effectiveMime,
        fileSize: payload.byteLength,
      })
      // The blob is back on the server — drop the stale "evicted" probe result
      // so any sibling bubble for the same path re-probes fresh.
      evictionProbeCache.delete(mediaPath)
      setServerEvicted(false)
      setEvicted(false)
    } catch {
      setLoadErr(true)
    } finally {
      setRestoring(false)
    }
  }, [effectiveMime, envelope, isPublicMedia, mediaIv, mediaPath, restoring, sharedKey])

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

  if (evicted) {
    return (
      <div ref={sentinelRef}>
        <MediaEvictedPlaceholder />
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
    // Files: show the card (name/size/type) IMMEDIATELY from envelope metadata
    // while the bytes decrypt in the background, instead of a blank spinner — the
    // download activates once ready (issue #14).
    if (attachmentKind === 'file') {
      const fileName = envelope?.fileName ?? mediaPath.split('/').pop() ?? 'FILE'
      const fileExt = fileName.split('.').pop()?.toLowerCase() ?? ''
      return (
        <div ref={sentinelRef}>
          <div className="p13-file-card mt-2 max-w-sm font-mono">
            <div className="flex items-center gap-3 p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neon-cyan/30 bg-void">
                <FileText className="h-5 w-5 text-neon-cyan/60" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text-primary">{fileName}</p>
                <div className="flex items-center gap-2 text-[10px] text-text-muted/70">
                  {fileExt ? <span className="uppercase">{fileExt}</span> : null}
                  {envelope?.fileSize != null ? <span>{formatFileSize(envelope.fileSize)}</span> : null}
                </div>
              </div>
              <span className="flex h-8 w-8 shrink-0 animate-pulse items-center justify-center text-neon-cyan/40" title={t('media.restoring')} aria-label={t('media.restoring')}>
                <Download className="h-4 w-4" />
              </span>
            </div>
          </div>
        </div>
      )
    }
    // Sprint M1-8 — render the tiny base64 JPEG preview blurred while we
    // decrypt + decode the real image. Falls back to the text shimmer when
    // the sender's client predates the placeholder field.
    if (envelope?.thumbhash) {
      return (
        <div ref={sentinelRef} className="mt-2 max-w-xs overflow-hidden rounded">
          <img
            src={envelope.thumbhash}
            alt=""
            aria-hidden
            className="h-auto w-full max-h-[300px] object-cover blur-md scale-110"
          />
        </div>
      )
    }
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
  const restoreControl = serverEvicted ? (
    <button
      type="button"
      onClick={() => void restoreToServer()}
      disabled={restoring}
      className="p13-media-action-btn flex min-h-8 items-center gap-1 px-2 font-mono text-[9px] uppercase tracking-widest disabled:opacity-50"
    >
      {restoring ? t('media.restoring') : t('media.restoreServer')}
    </button>
  ) : null

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
            onError={(e) => {
              // A failed decrypt/decode used to leave a phantom invisible tile
              // (opacity 0.01; onLoad never fires). Make it visible + dimmed so
              // the failure is obvious rather than a blank clickable tile (#14).
              e.currentTarget.style.opacity = '1'
              e.currentTarget.style.filter = 'grayscale(0.6) brightness(0.7)'
            }}
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
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {restoreControl}
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
              if (!el) return
              setCurrentSec(el.currentTime)
              const total =
                Number.isFinite(el.duration) && el.duration > 0 ? el.duration : envDurationSec
              if (total > 0) setProgress((el.currentTime / total) * 100)
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
              aria-label={playing ? t('media.pause') : t('media.play')}
              title={playing ? t('media.pause') : t('media.play')}
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
            <div
              className="flex h-7 flex-1 cursor-pointer items-end gap-[1px]"
              onClick={(e) => {
                const el = audioRef.current
                if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                el.currentTime = ratio * el.duration
              }}
              title="Click to seek"
            >
              {barHeights.map((h, i) => {
                const barPos = i / barHeights.length
                const played = barPos < progress / 100
                return (
                  <div
                    key={i}
                    className="min-w-[2px] flex-1 rounded-[1px] transition-colors duration-100"
                    style={{
                      height: `${Math.round(h * 100)}%`,
                      backgroundColor: played ? 'var(--neon-cyan, #22d3ee)' : 'color-mix(in srgb, var(--neon-cyan, #22d3ee) 28%, transparent)',
                    }}
                  />
                )
              })}
            </div>
            <span className="shrink-0 font-mono text-[9px] tabular-nums text-neon-cyan/70">
              {formatTime(currentSec)} / {formatTime(shownDuration)}
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
        {restoreControl ? <div className="mt-2 flex justify-end">{restoreControl}</div> : null}
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
                  } else if (envDurationSec <= 0) {
                    // Legacy circle (no record-time metadata): force the browser to
                    // compute the real duration once (WebM reports Infinity). New
                    // circles skip this — envDurationSec drives display/progress and
                    // the seek would fight the autoPlay+loop and reset the ring (#11).
                    el.currentTime = 1e10
                  }
                }}
                onDurationChange={() => {
                  const el = videoRef.current
                  if (!el) return
                  if (Number.isFinite(el.duration) && el.duration > 0) {
                    setDuration(el.duration)
                  }
                }}
                onTimeUpdate={() => {
                  const el = videoRef.current
                  if (!el) return
                  setCurrentSec(el.currentTime)
                  const total =
                    Number.isFinite(el.duration) && el.duration > 0 ? el.duration : envDurationSec
                  if (total > 0) setProgress((el.currentTime / total) * 100)
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
                    {formatTime(currentSec)} / {formatTime(shownDuration)}
                  </span>
                ) : (
                  <span className="font-mono text-[9px] text-neon-cyan/50 tracking-widest tabular-nums">
                    {shownDuration > 0 ? formatTime(shownDuration) : 'CIRCLE'}
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
          {restoreControl ? <div className="mt-2 flex justify-end">{restoreControl}</div> : null}
          {caption ? <MediaCaption text={caption} /> : null}
        </div>
      )
    }

    return (
      <div>
        <div className="p13-video-card mt-2 max-w-md p-1" style={{ aspectRatio: '16/9' }}>
          {/* Real inline player: native controls (usable — no click-to-lightbox
              fighting them) and unmuted so it has sound. Fullscreen is a separate
              explicit button below (issue #14). */}
          <video
            ref={videoRef}
            src={objectUrl}
            className="aspect-video w-full bg-void object-contain"
            playsInline
            autoPlay={false}
            controls
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {restoreControl}
          <button
            type="button"
            onClick={() => onMediaClick?.({
              id: message.id,
              url: objectUrl,
              type: 'video',
              mimeType: effectiveMime,
            })}
            className="p13-media-action-btn flex h-8 items-center gap-1 px-2 font-mono text-[9px] uppercase tracking-widest"
            title={t('media.fullscreen')}
          >
            <Maximize2 className="h-3 w-3" />
            {t('media.fullscreen')}
          </button>
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
      {restoreControl ? <div className="mt-2 flex justify-end">{restoreControl}</div> : null}
      {caption ? <MediaCaption text={caption} /> : null}
    </div>
  )
}

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, X, FileText, ChevronRight, ArrowUp, ArrowDown, Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { explainSendError } from '@/lib/explain-send-error'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type QueuedFile = {
  file: File
  mediaType: 'image' | 'video' | 'audio' | 'file'
}

type Props = {
  file: File
  mediaType: 'image' | 'video' | 'audio' | 'file'
  /** Full queue including current file — for thumbnail strip */
  queue: QueuedFile[]
  /** Called when user removes a specific index from the queue */
  onRemoveFromQueue: (index: number) => void
  /** Reorder a queued file from `from` to `to`. */
  onReorder?: (from: number, to: number) => void
  /** Append more files to the queue (TG-style "+ add more"). */
  onAddMore?: (files: File[]) => void
  onSend: (caption: string, opts: { sendOriginal: boolean }) => Promise<void>
  onCancel: () => void
}

/**
 * Larger album-grid thumbnail with reorder + delete controls.
 *
 * The controls are always visible below `md` and hover-revealed above it. They
 * used to be `opacity-0` unconditionally, which on a phone — the device where
 * albums are actually composed — meant the remove and reorder buttons never
 * appeared at all, while staying hit-testable: the only way to drop a wrongly
 * picked photo was to cancel the whole selection, and a stray tap in the corner
 * deleted one with no affordance at all.
 */
function AlbumThumb({
  item,
  index,
  total,
  onRemove,
  onReorder,
}: {
  item: QueuedFile
  index: number
  total: number
  onRemove: (i: number) => void
  onReorder?: (from: number, to: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (item.mediaType !== 'image' && item.mediaType !== 'video') return
    const u = URL.createObjectURL(item.file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [item.file, item.mediaType])

  return (
    <div className="group relative aspect-square overflow-hidden border border-border-strong bg-void">
      {item.mediaType === 'video' && url ? (
        <video src={url} muted playsInline className="h-full w-full object-cover" />
      ) : url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <FileText className="h-5 w-5 text-neon-cyan/40" />
        </div>
      )}
      <span className="absolute left-0 top-0 bg-void/70 px-1 font-mono text-[9px] text-text-muted">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center bg-void/80 text-text-muted opacity-100 transition-opacity hover:text-neon-red md:opacity-0 md:group-hover:opacity-100"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>
      {onReorder ? (
        <div className="absolute bottom-0 left-0 right-0 flex justify-between bg-void/70 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onReorder(index, index - 1)}
            className="flex h-8 w-8 items-center justify-center text-neon-cyan disabled:opacity-30"
            aria-label="Move up"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onReorder(index, index + 1)}
            className="flex h-8 w-8 items-center justify-center text-neon-cyan disabled:opacity-30"
            aria-label="Move down"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Small thumbnail for the strip */
function QueueThumb({
  item,
  index,
  isActive,
  onRemove,
}: {
  item: QueuedFile
  index: number
  isActive: boolean
  onRemove: (i: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (item.mediaType !== 'image' && item.mediaType !== 'video') return
    const u = URL.createObjectURL(item.file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [item.file, item.mediaType])

  return (
    <div className={`relative shrink-0 h-12 w-12 border ${
      isActive ? 'border-neon-cyan' : 'border-border-strong'
    } bg-void overflow-hidden`}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <FileText className="h-5 w-5 text-neon-cyan/40" />
        </div>
      )}
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-void/80 text-text-muted hover:text-neon-red"
        aria-label="Remove"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}

export function MediaPreviewModal({
  file,
  mediaType,
  queue,
  onRemoveFromQueue,
  onReorder,
  onAddMore,
  onSend,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  const [caption, setCaption] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // Sprint M1-6 — TG-style "Send as file" toggle. When on, image
  // compression and resize are skipped so the recipient receives the
  // exact original bytes.
  const [sendOriginal, setSendOriginal] = useState(false)
  const captionRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setCaption('')
    if (mediaType === 'image' || mediaType === 'video' || mediaType === 'audio') {
      const url = URL.createObjectURL(file)
      setPreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    setPreviewUrl(null)
  }, [file, mediaType])

  useEffect(() => {
    captionRef.current?.focus()
  }, [file])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (sending) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  const handleSend = async () => {
    if (sending) return
    setSendError(null)
    setSending(true)
    try {
      await onSend(caption.trim(), { sendOriginal })
      setCaption('')
    } catch (err) {
      setSendError(explainSendError(err) || t('mediaPreview.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  const queueRemaining = queue.length - 1

  // Album mode: 2+ image/video items will be sent as a single grouped
  // message via sendAlbum. We show a grid with reorder controls instead
  // of the one-at-a-time strip.
  const isAlbumMode = useMemo(
    () =>
      queue.length >= 2 &&
      queue.every((q) => q.mediaType === 'image' || q.mediaType === 'video'),
    [queue]
  )
  const albumAddRef = useRef<HTMLInputElement>(null)

  if (isAlbumMode) {
    return (
      <div data-testid="media-preview-modal" className="mb-2 border border-neon-cyan/30 bg-void">
        <div className="flex items-center justify-between border-b border-border-strong px-3 py-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.4em] text-neon-cyan/70">
            Album · {queue.length} items
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted/70 hover:text-neon-red transition-colors"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1 p-2 sm:grid-cols-4 md:grid-cols-5">
          {queue.map((item, i) => (
            <AlbumThumb
              key={`${item.file.name}-${item.file.size}-${i}`}
              item={item}
              index={i}
              total={queue.length}
              onRemove={onRemoveFromQueue}
              onReorder={onReorder}
            />
          ))}
          {onAddMore && queue.length < 9 ? (
            <>
              <button
                type="button"
                onClick={() => albumAddRef.current?.click()}
                className="flex aspect-square items-center justify-center border border-dashed border-neon-cyan/30 bg-void text-neon-cyan/60 hover:border-neon-cyan/60 hover:text-neon-cyan"
                aria-label="Add more"
              >
                <Plus className="h-5 w-5" />
              </button>
              <input
                ref={albumAddRef}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => {
                  if (!e.target.files?.length) return
                  const arr = Array.from(e.target.files)
                  onAddMore(arr)
                  e.target.value = ''
                }}
              />
            </>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 border-t border-border-strong p-2">
          <textarea
            ref={captionRef}
            data-testid="media-preview-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            maxLength={1024}
            placeholder={t('mediaPreview.captionPlaceholder')}
            disabled={sending}
            style={{ fontSize: 'max(16px, 1em)' }}
            className="w-full resize-none border border-border-strong bg-void px-2 py-1.5 font-mono text-[13px] text-neon-cyan outline-none focus:border-neon-cyan/50 placeholder:text-text-muted/70"
          />
          {sendError ? <p className="text-[9px] text-neon-red">{sendError}</p> : null}
          {queue.some((q) => q.mediaType === 'image') && (
            <label className="flex items-center gap-1.5 font-mono text-[10px] text-text-muted/80 select-none">
              <input
                type="checkbox"
                checked={sendOriginal}
                onChange={(e) => setSendOriginal(e.target.checked)}
                disabled={sending}
                className="h-3 w-3 accent-neon-cyan"
              />
              {t('mediaPreview.sendAsFile')}
            </label>
          )}
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending}
            data-testid="media-preview-send"
            className="flex items-center justify-center gap-1.5 border border-neon-cyan bg-void py-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            {sending
              ? t('mediaPreview.sending')
              : t('mediaPreview.sendAlbum').replace('{count}', String(queue.length))}
          </button>
        </div>
      </div>
    )
  }

  return (
    // Inline panel — no overlay, sits above the input row inside the form
    <div data-testid="media-preview-modal" className="mb-2 border border-neon-cyan/30 bg-void">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-strong px-3 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.4em] text-neon-cyan/70">
          {t('mediaPreview.title')}
          {queueRemaining > 0 && (
            <span className="ml-2 text-neon-cyan/40">
              <ChevronRight className="inline h-3 w-3" />
              {queueRemaining} more
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-muted/70 hover:text-neon-red transition-colors"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex gap-2 p-2">
        {/* Preview thumbnail — current file */}
        <div className="relative shrink-0 w-24 h-24 border border-border-strong bg-void overflow-hidden">
          {mediaType === 'image' && previewUrl ? (
            <img src={previewUrl} alt={file.name} className="h-full w-full object-cover" />
          ) : mediaType === 'video' && previewUrl ? (
            <video src={previewUrl} className="h-full w-full object-cover" muted playsInline />
          ) : mediaType === 'audio' ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-neon-cyan/40 text-neon-cyan">
                ♪
              </div>
              <span className="text-center font-mono text-[8px] text-text-muted break-all leading-tight line-clamp-2">
                {file.name}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1">
              <FileText className="h-7 w-7 text-neon-cyan/40" />
              <span className="text-center font-mono text-[8px] text-text-muted break-all leading-tight line-clamp-2">
                {file.name}
              </span>
            </div>
          )}
          <span className="absolute bottom-0 left-0 right-0 bg-void/70 px-1 py-0.5 font-mono text-[7px] text-text-muted truncate">
            {formatFileSize(file.size)}
          </span>
        </div>

        {/* Caption + send */}
        <div className="flex flex-1 flex-col gap-1.5 min-w-0">
          {mediaType === 'audio' && previewUrl ? (
            <audio src={previewUrl} controls preload="metadata" className="h-10 w-full opacity-80" />
          ) : null}
          <textarea
            ref={captionRef}
            data-testid="media-preview-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            maxLength={512}
            className="w-full flex-1 resize-none border border-border-strong bg-void px-2 py-1.5 font-mono text-[13px] text-neon-cyan outline-none transition-colors focus:border-neon-cyan/50 placeholder:text-text-muted/70"
            style={{ fontSize: 'max(16px, 1em)' }}
            placeholder={t('mediaPreview.captionPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={sending}
          />
          {sendError ? <p className="text-[9px] text-neon-red">{sendError}</p> : null}
          {(mediaType === 'image' || queue.some((q) => q.mediaType === 'image')) && (
            <label className="flex items-center gap-1.5 font-mono text-[10px] text-text-muted/80 select-none">
              <input
                type="checkbox"
                checked={sendOriginal}
                onChange={(e) => setSendOriginal(e.target.checked)}
                disabled={sending}
                className="h-3 w-3 accent-neon-cyan"
              />
              {t('mediaPreview.sendAsFile')}
            </label>
          )}
          {/* type=button + single onClick only, no onTouchEnd */}
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending}
            data-testid="media-preview-send"
            aria-label="Send attachment"
            className="flex items-center justify-center gap-1.5 border border-neon-cyan bg-void py-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            {sending
              ? t('mediaPreview.sending')
              : queueRemaining > 0
                ? t('mediaPreview.sendAndNext')
                : t('mediaPreview.send')}
          </button>
        </div>
      </div>

      {/* Thumbnail strip — visible only when queue has multiple files */}
      {queue.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-t border-border-strong px-2 py-1.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-neon-cyan/20">
          {queue.map((item, i) => (
            <QueueThumb
              key={`${item.file.name}-${item.file.size}-${i}`}
              item={item}
              index={i}
              isActive={i === 0}
              onRemove={onRemoveFromQueue}
            />
          ))}
        </div>
      )}
    </div>
  )
}

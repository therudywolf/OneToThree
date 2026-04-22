'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, X, FileText, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

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
  onSend: (caption: string) => Promise<void>
  onCancel: () => void
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
  onSend,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  const [caption, setCaption] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
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
      await onSend(caption.trim())
      setCaption('')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : t('mediaPreview.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  const queueRemaining = queue.length - 1

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

'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, X, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Props = {
  file: File
  mediaType: 'image' | 'video' | 'audio' | 'file'
  onSend: (caption: string) => void
  onCancel: () => void
}

export function MediaPreviewModal({ file, mediaType, onSend, onCancel }: Props) {
  const { t } = useTranslation()
  const [caption, setCaption] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const captionRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (mediaType === 'image' || mediaType === 'video') {
      const url = URL.createObjectURL(file)
      setPreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [file, mediaType])

  useEffect(() => {
    captionRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(caption.trim())
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-zinc-950/90 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="relative w-full max-w-lg border border-neutral-900 bg-black p-4 shadow-2xl">
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-cyan to-transparent opacity-50" />

        <header className="mb-4 flex items-center justify-between border-b border-neutral-900 pb-3">
          <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
            {t('mediaPreview.title')}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="text-zinc-700 transition-colors hover:text-neon-red"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Preview area */}
        <div className="mb-4 flex items-center justify-center border border-neutral-900 bg-zinc-950 p-2 min-h-[120px] max-h-[50vh] overflow-hidden">
          {mediaType === 'image' && previewUrl ? (
            <img
              src={previewUrl}
              alt={file.name}
              className="max-h-[48vh] max-w-full object-contain"
            />
          ) : mediaType === 'video' && previewUrl ? (
            <video
              src={previewUrl}
              controls
              playsInline
              className="max-h-[48vh] max-w-full"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <FileText className="h-12 w-12 text-neon-cyan/40" />
              <div>
                <p className="font-mono text-xs text-neon-cyan/80 break-all">
                  {file.name}
                </p>
                <p className="mt-1 font-mono text-[9px] text-zinc-500">
                  {t('mediaPreview.size')}: {formatFileSize(file.size)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Caption input */}
        <div className="mb-4">
          <textarea
            ref={captionRef}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            maxLength={512}
            className="w-full resize-none border border-neutral-900 bg-zinc-950 px-3 py-2 font-mono text-white outline-none transition-all focus:border-neon-cyan/50 placeholder:text-zinc-600"
            style={{ fontSize: 'max(16px, 1em)' }}
            placeholder={t('mediaPreview.captionPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onSend(caption.trim())}
            className="flex flex-1 items-center justify-center gap-2 border border-neon-cyan bg-black py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black"
          >
            <Send className="h-3.5 w-3.5" />
            {t('mediaPreview.send')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="border border-neutral-800 bg-black px-6 py-2.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600 transition-all hover:border-neon-red hover:text-neon-red"
          >
            {t('mediaPreview.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Paperclip, Smile, Mic, Video, Lock, X, Square, Image, FileVideo, FileAudio, FileText } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { useTranslation } from '@/hooks/use-translation'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { resumeAudioContextAfterGesture } from '@/lib/call-ringtones'
import { vibrateShort } from '@/lib/vibrate'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import EmojiPicker from 'emoji-picker-react'
import { MediaPreviewModal } from '@/components/chat/media-preview-modal'

function detectMediaType(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

const LOCK_THRESHOLD_Y = 60
const CANCEL_THRESHOLD_X = 80
const HOLD_THRESHOLD_MS = 200

type Props = {
  sendText: (
    t: string,
    replyToId?: string | null,
    opts?: { burn_at?: string | null }
  ) => Promise<void>
  sendMedia: (
    blob: Blob,
    mediaType: 'audio' | 'video' | 'image' | 'file',
    caption?: string,
    options?: { fileName?: string; fileType?: string }
  ) => Promise<void>
  cryptoCtx: ChatCryptoContext | null
  disabled?: boolean
}

type QueuedFile = { file: File; mediaType: 'image' | 'video' | 'audio' | 'file' }

export function ChatInput({ sendText, sendMedia, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const [messageText, setMessageText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [mediaMode, setMediaMode] = useState<'voice' | 'circle'>('voice')

  const isRecordingRef = useRef(false)
  const [isRecordingUI, setIsRecordingUI] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [recordLocked, setRecordLocked] = useState(false)
  const [swipeOffsetY, setSwipeOffsetY] = useState(0)
  const [swipeOffsetX, setSwipeOffsetX] = useState(0)
  const [, setCancelSlide] = useState(false)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const lockAnimRef = useRef(false)

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isHoldRef = useRef(false)

  const [fileQueue, setFileQueue] = useState<QueuedFile[]>([])
  const previewFile = fileQueue[0] ?? null

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiContainerRef = useRef<HTMLDivElement>(null)
  const attachContainerRef = useRef<HTMLDivElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  const {
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream,
  } = useMediaRecorder()

  const videoPreviewRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoPreviewRef.current
    if (!el) return
    if (previewStream && mediaMode === 'circle') {
      el.srcObject = previewStream
    } else {
      el.srcObject = null
    }
  }, [previewStream, mediaMode])

  useEffect(() => {
    if (!emojiOpen) return
    const close = (e: MouseEvent) => {
      if (emojiContainerRef.current?.contains(e.target as Node)) return
      setEmojiOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  useEffect(() => {
    if (!attachOpen) return
    const close = (e: MouseEvent) => {
      if (attachContainerRef.current?.contains(e.target as Node)) return
      setAttachOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [attachOpen])

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
    }
  }, [])

  const startRecording = async () => {
    if (!cryptoCtx || disabled || isRecordingRef.current) return
    isRecordingRef.current = true
    setIsRecordingUI(true)
    setRecordSeconds(0)
    setRecordLocked(false)
    setCancelSlide(false)
    setSwipeOffsetY(0)
    setSwipeOffsetX(0)
    lockAnimRef.current = false
    recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    vibrateShort(12)
    try {
      await resumeAudioContextAfterGesture()
      if (mediaMode === 'voice') await startVoiceCapture()
      else await startVideoCircleCapture()
    } catch (error) {
      console.error('Failed to start recording:', error)
      isRecordingRef.current = false
      setIsRecordingUI(false)
      setRecordLocked(false)
      if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    }
  }

  const stopRecording = useCallback(async (shouldSend = true) => {
    if (!isRecordingRef.current) return
    isRecordingRef.current = false
    setIsRecordingUI(false)
    setRecordLocked(false)
    setCancelSlide(false)
    setSwipeOffsetY(0)
    setSwipeOffsetX(0)
    pointerStartRef.current = null
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    try {
      const result = await stopCapture()
      if (shouldSend && result && result.blob.size > 0 && cryptoCtx) {
        await sendMedia(result.blob, mediaMode === 'voice' ? 'audio' : 'video', undefined, { fileType: result.mimeType })
      } else if (!shouldSend) {
        // cancelled
      } else {
        console.warn('Capture stopped but blob is empty or null.')
      }
    } catch (error) {
      console.error('Failed to stop recording:', error)
    }
  }, [stopCapture, sendMedia, cryptoCtx, mediaMode])

  const cancelRecording = useCallback(async () => {
    vibrateShort(30)
    await stopRecording(false)
  }, [stopRecording])

  const formatRecordTime = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const insertEmoji = (emoji: string) => {
    setMessageText((prev) => {
      const el = inputRef.current
      if (!el) return prev + emoji
      const start = el.selectionStart ?? prev.length
      const end = el.selectionEnd ?? prev.length
      const next = prev.slice(0, start) + emoji + prev.slice(end)
      queueMicrotask(() => {
        const pos = start + emoji.length
        el.focus()
        try { el.setSelectionRange(pos, pos) } catch { /* ignore */ }
      })
      onDraftChanged(next)
      return next
    })
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.files.length) return
    const queued: QueuedFile[] = Array.from(e.clipboardData.files).map((file) => ({ file, mediaType: detectMediaType(file) }))
    if (queued.length === 0) return
    e.preventDefault()
    setFileQueue(queued)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    containerRef.current?.classList.add('drag-over')
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    containerRef.current?.classList.remove('drag-over')
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    containerRef.current?.classList.remove('drag-over')
    if (!e.dataTransfer?.files.length) return
    setFileQueue(Array.from(e.dataTransfer.files).map((file) => ({ file, mediaType: detectMediaType(file) })))
  }

  const triggerFileInput = (accept: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept
      fileInputRef.current.click()
    }
    setAttachOpen(false)
  }

  const handleAttachClick = () => {
    if (window.matchMedia('(pointer: coarse)').matches) {
      triggerFileInput('image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt')
    } else {
      setAttachOpen((o) => !o)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    setFileQueue(Array.from(e.target.files).map((file) => ({ file, mediaType: detectMediaType(file) })))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handlePreviewSend = useCallback((caption: string) => {
    setFileQueue((prev) => {
      const item = prev[0]
      if (!item) return prev
      void sendMedia(item.file, item.mediaType, caption || undefined, { fileName: item.file.name, fileType: item.file.type })
      return prev.slice(1)
    })
  }, [sendMedia])

  const handlePreviewCancel = useCallback(() => setFileQueue([]), [])
  const handleRemoveFromQueue = useCallback((index: number) => {
    setFileQueue((prev) => prev.filter((_, i) => i !== index))
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!messageText.trim() || disabled) return
    await sendText(messageText, replyTo?.id ?? null)
    onSubmitOrClear()
    setMessageText('')
    setReplyTo(null)
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.focus()
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => e.preventDefault()

  const handleRecordPointerDown = (e: React.PointerEvent) => {
    if (disabled || !cryptoCtx) return
    e.preventDefault()
    isHoldRef.current = false
    pointerStartRef.current = { x: e.clientX, y: e.clientY }
    holdTimerRef.current = setTimeout(() => {
      isHoldRef.current = true
      void startRecording()
    }, HOLD_THRESHOLD_MS)
  }

  const handleRecordPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isRecordingRef.current || recordLocked || !pointerStartRef.current) return
    const dy = pointerStartRef.current.y - e.clientY
    const dx = pointerStartRef.current.x - e.clientX
    setSwipeOffsetY(Math.max(0, dy))
    setSwipeOffsetX(Math.max(0, dx))
    if (dy > LOCK_THRESHOLD_Y && !lockAnimRef.current) {
      lockAnimRef.current = true
      vibrateShort(20)
      setRecordLocked(true)
      setSwipeOffsetY(0); setSwipeOffsetX(0)
      pointerStartRef.current = null
      try { (e.target as Element).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    if (dx > CANCEL_THRESHOLD_X) { setCancelSlide(true); void cancelRecording() }
  }, [recordLocked, cancelRecording])

  const handleRecordPointerUp = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (!isHoldRef.current) {
      if (!isRecordingRef.current) { setMediaMode((prev) => (prev === 'voice' ? 'circle' : 'voice')); vibrateShort(8) }
      return
    }
    if (!isRecordingRef.current) return
    if (recordLocked) return
    pointerStartRef.current = null
    void stopRecording(true)
  }, [recordLocked, stopRecording])

  const waveformBars = Array.from({ length: 20 }, (_, i) => {
    const base = 0.3 + Math.sin(i * 0.7 + recordSeconds * 2) * 0.3
    return Math.max(0.15, Math.min(1, base + Math.random() * 0.2))
  })

  // On mobile: show mic when empty, show send when text present
  const showSendOnMobile = messageText.trim().length > 0

  return (
    <form
      ref={containerRef}
      onSubmit={(e) => void onSubmit(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="sticky bottom-0 z-10 shrink-0 touch-manipulation border-t border-neon-cyan/40 bg-black p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] transition-colors duration-200"
    >
      {previewFile && (
        <MediaPreviewModal
          file={previewFile.file}
          mediaType={previewFile.mediaType}
          queue={fileQueue}
          onRemoveFromQueue={handleRemoveFromQueue}
          onSend={handlePreviewSend}
          onCancel={handlePreviewCancel}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
        onChange={handleFileSelect}
        className="hidden"
        aria-label={t('chat.attachFile')}
      />

      {replyTo ? (
        <div className="mb-2 flex items-center gap-2 border-l-2 border-neon-cyan/50 pl-2">
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-neon-cyan/70">
            ↳ {t('chat.replyBanner')}:{' '}
            {replyTo.plaintext ? replyTo.plaintext.slice(0, 80) : '[MEDIA]'}
          </p>
          <button type="button" onClick={() => setReplyTo(null)} className="shrink-0 font-mono text-[10px] text-red-800 hover:text-neon-red">[X]</button>
        </div>
      ) : null}

      {/* Locked recording controls */}
      {isRecordingUI && recordLocked ? (
        <div className="flex items-center gap-3 py-1">
          <button type="button" onClick={() => void cancelRecording()}
            className="flex h-10 w-10 shrink-0 items-center justify-center border border-neon-red/70 bg-black text-neon-red transition-colors hover:bg-neon-red/10"
            title={t('common.cancel')}>
            <X className="h-4 w-4" />
          </button>
          {mediaMode === 'circle' && previewStream ? (
            <div className="relative aspect-square w-16 shrink-0 overflow-hidden rounded-full border-2 border-neon-red bg-black shadow-[0_0_12px_rgba(255,0,0,0.2)]">
              <video ref={videoPreviewRef} autoPlay playsInline muted className="h-full w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-center font-mono text-[7px] text-neon-red">{formatRecordTime(recordSeconds)}</span>
            </div>
          ) : null}
          <div className="flex flex-1 items-center gap-2 border border-neon-red/40 bg-zinc-950 px-3 py-2">
            <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-red-600 animate-pulse" />
            <span className="shrink-0 font-mono text-[10px] text-red-400 tabular-nums">{formatRecordTime(recordSeconds)}</span>
            <div className="flex h-6 flex-1 items-end gap-[1px]">
              {waveformBars.map((h, i) => (
                <div key={i} className="min-w-[2px] flex-1 rounded-[1px] bg-neon-red/70 transition-all duration-150" style={{ height: `${Math.round(h * 100)}%` }} />
              ))}
            </div>
            <Lock className="h-3 w-3 shrink-0 text-neon-cyan/60" />
          </div>
          <button type="button" onClick={() => void stopRecording(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center border border-neon-cyan bg-black text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            title={t('common.send')}>
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Normal input row */}
      <div className={`flex items-center gap-2 ${isRecordingUI && recordLocked ? 'hidden' : ''}`}>

        {/* Attach — always visible */}
        <div ref={attachContainerRef} className="relative shrink-0">
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center border border-neon-cyan/50 bg-black text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40 transition-colors"
            disabled={disabled || isRecordingUI}
            onClick={handleAttachClick}
            title={t('chat.attachFile')}
          >
            <Paperclip className="h-4 w-4" />
          </button>

          {attachOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 flex flex-col border border-neon-cyan/50 bg-black shadow-[0_0_16px_rgba(0,255,255,0.08)] min-w-[160px]">
              <button type="button" className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-neon-cyan/80 hover:bg-neon-cyan/10 hover:text-neon-cyan transition-colors text-left" onClick={() => triggerFileInput('image/*')}>
                <Image className="h-3.5 w-3.5 shrink-0" />{t('chat.attachImage') ?? 'Image'}
              </button>
              <button type="button" className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-neon-cyan/80 hover:bg-neon-cyan/10 hover:text-neon-cyan transition-colors text-left" onClick={() => triggerFileInput('video/*')}>
                <FileVideo className="h-3.5 w-3.5 shrink-0" />{t('chat.attachVideo') ?? 'Video'}
              </button>
              <button type="button" className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-neon-cyan/80 hover:bg-neon-cyan/10 hover:text-neon-cyan transition-colors text-left" onClick={() => triggerFileInput('audio/*')}>
                <FileAudio className="h-3.5 w-3.5 shrink-0" />{t('chat.attachAudio') ?? 'Audio'}
              </button>
              <div className="border-t border-neon-cyan/20" />
              <button type="button" className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-neon-cyan/80 hover:bg-neon-cyan/10 hover:text-neon-cyan transition-colors text-left" onClick={() => triggerFileInput('.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt')}>
                <FileText className="h-3.5 w-3.5 shrink-0" />{t('chat.attachDocument') ?? 'Document'}
              </button>
            </div>
          )}
        </div>

        {/* Input field */}
        <div className="relative flex-1">
          <div className={`flex items-center gap-2 rounded border px-3 py-2 ${
            isRecordingUI ? 'border-neon-red/70 bg-zinc-950' : 'border-neon-cyan/40 bg-black'
          }`}>
            <textarea
              ref={inputRef}
              rows={1}
              className="terminal-input flex-1 min-h-6 max-h-24 resize-none bg-transparent text-neon-cyan placeholder-neon-cyan/40 focus:outline-none disabled:cursor-not-allowed md:pr-8"
              style={{ fontSize: 'max(16px, 1em)' }}
              value={messageText}
              onChange={(e) => {
                const next = e.target.value
                setMessageText(next)
                onDraftChanged(next)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (messageText.trim() && !disabled) void onSubmit(e as unknown as React.FormEvent)
                }
                if (e.key === 'Escape' && replyTo) setReplyTo(null)
              }}
              onPaste={handlePaste}
              disabled={disabled || isRecordingUI}
              placeholder={isRecordingUI ? t('media.recording') : t('chat.inputPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />

            {isRecordingUI && !recordLocked ? (
              <span className="inline-flex items-center gap-1.5 shrink-0">
                {mediaMode === 'circle' && previewStream ? (
                  <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded-full border border-neon-red">
                    <video ref={videoPreviewRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                  </span>
                ) : null}
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-600 animate-pulse" />
                <span className="font-mono text-[10px] text-red-400 tabular-nums">{formatRecordTime(recordSeconds)}</span>
                {swipeOffsetY > 10 ? (
                  <Lock className="h-3 w-3 text-neon-cyan animate-bounce" />
                ) : (
                  <span className="font-mono text-[8px] text-zinc-500 uppercase">{t('media.swipeHint')}</span>
                )}
              </span>
            ) : null}
          </div>

          {/* Emoji button — desktop only, inside relative wrapper, picker opens above */}
          {!isRecordingUI ? (
            <div ref={emojiContainerRef} className="hidden md:block">
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center text-neon-cyan/30 hover:text-neon-cyan/70 transition-colors disabled:opacity-20 z-10"
                disabled={disabled}
                onClick={() => setEmojiOpen((o) => !o)}
                tabIndex={-1}
                title={t('emoji.pickerToggle')}
              >
                <Smile className="h-4 w-4" />
              </button>
              {emojiOpen && (
                <div className="absolute bottom-[calc(100%+0.5rem)] right-0 z-[60] border border-neon-cyan/50 bg-black shadow-[0_0_16px_rgba(0,255,255,0.12)]">
                  <EmojiPicker
                    onEmojiClick={(emojiData) => { insertEmoji(emojiData.emoji); setEmojiOpen(false) }}
                    skinTonesDisabled
                    searchDisabled
                    previewConfig={{ showPreview: false }}
                    width={300}
                    height={350}
                  />
                </div>
              )}
            </div>
          ) : null}

          {isRecordingUI && !recordLocked && swipeOffsetX > 20 ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-red-950/80 border border-neon-red/50 rounded transition-opacity"
              style={{ opacity: Math.min(1, swipeOffsetX / CANCEL_THRESHOLD_X) }}
            >
              <span className="font-mono text-[10px] text-neon-red uppercase tracking-widest">{t('media.slideCancel')}</span>
            </div>
          ) : null}
        </div>

        {/* Record button — desktop always visible; mobile only when input is empty */}
        <button
          type="button"
          className={`shrink-0 select-none border bg-black transition-all disabled:opacity-40
            flex h-10 w-10 items-center justify-center
            ${
              isRecordingUI
                ? 'border-red-600 bg-red-950/20 text-red-300'
                : mediaMode === 'voice'
                ? 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10'
                : 'border-neon-red text-neon-red hover:bg-neon-red/10'
            }
            ${showSendOnMobile ? 'hidden md:flex' : 'flex'}
          `}
          disabled={disabled || !cryptoCtx}
          onContextMenu={handleContextMenu}
          onPointerDown={handleRecordPointerDown}
          onPointerMove={handleRecordPointerMove}
          onPointerUp={handleRecordPointerUp}
          onPointerCancel={handleRecordPointerUp}
          title={
            isRecordingUI ? t('media.recording')
              : mediaMode === 'voice' ? t('media.tapSwitchCircle')
              : t('media.tapSwitchVoice')
          }
          style={{ touchAction: 'none' }}
        >
          {isRecordingUI ? (
            <Square className="h-3.5 w-3.5 fill-red-500 text-red-500" />
          ) : mediaMode === 'voice' ? (
            <Mic className="h-4 w-4" />
          ) : (
            <Video className="h-4 w-4" />
          )}
        </button>

        {/* Send — always h-10 w-10, mobile shows only when text present */}
        <button
          type="submit"
          disabled={disabled || !messageText.trim() || isRecordingUI}
          className={`shrink-0 flex h-10 w-10 items-center justify-center border border-neon-cyan bg-black text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40 transition-colors
            ${showSendOnMobile ? 'flex' : 'hidden md:flex'}
          `}
          title={t('common.send')}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Paperclip, Smile, Mic, Video, Lock, X, Square } from 'lucide-react'
import { useChatStore } from '@/store/chatStore'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { useTranslation } from '@/hooks/use-translation'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { resumeAudioContextAfterGesture } from '@/lib/call-ringtones'
import { vibrateShort } from '@/lib/vibrate'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import EmojiPicker from 'emoji-picker-react'

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function detectMediaType(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Threshold in px the pointer must travel upward to lock recording */
const LOCK_THRESHOLD_Y = 60
/** Threshold in px the pointer must travel left to cancel recording */
const CANCEL_THRESHOLD_X = 80

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

export function ChatInput({ sendText, sendMedia, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const [messageText, setMessageText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [mediaMode, setMediaMode] = useState<'voice' | 'circle'>('voice')

  const isRecordingRef = useRef(false)
  const [isRecordingUI, setIsRecordingUI] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Swipe-to-lock state
  const [recordLocked, setRecordLocked] = useState(false)
  const [swipeOffsetY, setSwipeOffsetY] = useState(0)
  const [swipeOffsetX, setSwipeOffsetX] = useState(0)
  const [cancelSlide, setCancelSlide] = useState(false)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const lockAnimRef = useRef(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiContainerRef = useRef<HTMLDivElement>(null)
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
      // Don't close if click is inside the emoji picker container
      if (emojiContainerRef.current?.contains(e.target as Node)) return
      setEmojiOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  // Cleanup recording timer on unmount
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
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
    recordTimerRef.current = setInterval(() => {
      setRecordSeconds((s) => s + 1)
    }, 1000)
    vibrateShort(12)

    try {
      await resumeAudioContextAfterGesture()
      if (mediaMode === 'voice') {
        await startVoiceCapture()
      } else {
        await startVideoCircleCapture()
      }
    } catch (error) {
      console.error('Failed to start recording:', error)
      isRecordingRef.current = false
      setIsRecordingUI(false)
      setRecordLocked(false)
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
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
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }

    try {
      const result = await stopCapture()
      if (shouldSend && result && result.blob.size > 0 && cryptoCtx) {
        await sendMedia(
          result.blob,
          mediaMode === 'voice' ? 'audio' : 'video',
          undefined,
          { fileType: result.mimeType }
        )
      } else if (!shouldSend) {
        // Cancelled — blob discarded
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
        try {
          el.setSelectionRange(pos, pos)
        } catch { /* ignore */ }
      })

      onDraftChanged(next)
      return next
    })
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.files.length) return

    for (const file of e.clipboardData.files) {
      if (isImageFile(file)) {
        e.preventDefault()
        await sendMedia(file, 'image')
      }
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    containerRef.current?.classList.add('drag-over')
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    containerRef.current?.classList.remove('drag-over')
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    containerRef.current?.classList.remove('drag-over')

    if (!e.dataTransfer?.files.length) return

    for (const file of e.dataTransfer.files) {
      const mediaType = detectMediaType(file)
      await sendMedia(file, mediaType, undefined, {
        fileName: file.name,
        fileType: file.type,
      })
    }
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return

    for (const file of e.target.files) {
      const mediaType = detectMediaType(file)
      await sendMedia(file, mediaType, undefined, {
        fileName: file.name,
        fileType: file.type,
      })
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
  }

  // --- Pointer handlers for swipe-to-lock ---
  const handleRecordPointerDown = (e: React.PointerEvent) => {
    if (disabled || !cryptoCtx) return
    e.preventDefault()
    pointerStartRef.current = { x: e.clientX, y: e.clientY }
    void startRecording()
  }

  const handleRecordPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isRecordingRef.current || recordLocked || !pointerStartRef.current) return

    const dy = pointerStartRef.current.y - e.clientY // positive = up
    const dx = pointerStartRef.current.x - e.clientX // positive = left

    setSwipeOffsetY(Math.max(0, dy))
    setSwipeOffsetX(Math.max(0, dx))

    // Lock if swiped up enough
    if (dy > LOCK_THRESHOLD_Y && !lockAnimRef.current) {
      lockAnimRef.current = true
      vibrateShort(20)
      setRecordLocked(true)
      setSwipeOffsetY(0)
      setSwipeOffsetX(0)
      pointerStartRef.current = null
    }

    // Cancel if swiped left enough
    if (dx > CANCEL_THRESHOLD_X) {
      setCancelSlide(true)
      void cancelRecording()
    }
  }, [recordLocked, cancelRecording])

  const handleRecordPointerUp = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    if (!isRecordingRef.current) return
    // If locked, do nothing (user uses stop/cancel buttons)
    if (recordLocked) return
    // If not locked, stop and send
    pointerStartRef.current = null
    void stopRecording(true)
  }, [recordLocked, stopRecording])

  // Waveform bars for locked recording UI
  const waveformBars = Array.from({ length: 20 }, (_, i) => {
    const base = 0.3 + Math.sin(i * 0.7 + recordSeconds * 2) * 0.3
    return Math.max(0.15, Math.min(1, base + Math.random() * 0.2))
  })

  return (
    <form
      ref={containerRef}
      onSubmit={(e) => void onSubmit(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="sticky bottom-0 z-10 shrink-0 touch-manipulation border-t border-neon-cyan/40 bg-black p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] transition-colors duration-200 data-[drag-over=true]:bg-neon-cyan/5"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
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
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="shrink-0 font-mono text-[10px] text-red-800 hover:text-neon-red"
          >
            [X]
          </button>
        </div>
      ) : null}

      {emojiOpen ? (
        <div
          ref={emojiContainerRef}
          className="relative z-10 mb-2 border border-neon-cyan/50 bg-black p-2 shadow-[inset_0_0_12px_rgba(0,255,255,0.08)]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <EmojiPicker
            onEmojiClick={(emojiData) => {
              insertEmoji(emojiData.emoji)
              setEmojiOpen(false)
            }}
            skinTonesDisabled
            searchDisabled
            previewConfig={{ showPreview: false }}
            width={300}
            height={350}
          />
        </div>
      ) : null}

      {/* --- Locked recording controls --- */}
      {isRecordingUI && recordLocked ? (
        <div className="flex items-center gap-3 py-1">
          {/* Cancel button */}
          <button
            type="button"
            onClick={() => void cancelRecording()}
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-neon-red/70 bg-black text-neon-red transition-colors hover:bg-neon-red/10"
            title={t('common.cancel')}
          >
            <X className="h-4 w-4" />
          </button>

          {/* Circle video preview when recording in circle mode */}
          {mediaMode === 'circle' && previewStream ? (
            <div className="relative aspect-square w-16 shrink-0 overflow-hidden rounded-full border-2 border-neon-red bg-black shadow-[0_0_12px_rgba(255,0,0,0.2)]">
              <video
                ref={videoPreviewRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-center font-mono text-[7px] text-neon-red">
                {formatRecordTime(recordSeconds)}
              </span>
            </div>
          ) : null}

          {/* Waveform + timer */}
          <div className="flex flex-1 items-center gap-2 border border-neon-red/40 bg-zinc-950 px-3 py-2">
            <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-red-600 animate-pulse" />
            <span className="shrink-0 font-mono text-[10px] text-red-400 tabular-nums">
              {formatRecordTime(recordSeconds)}
            </span>
            <div className="flex h-6 flex-1 items-end gap-[1px]">
              {waveformBars.map((h, i) => (
                <div
                  key={i}
                  className="min-w-[2px] flex-1 rounded-[1px] bg-neon-red/70 transition-all duration-150"
                  style={{ height: `${Math.round(h * 100)}%` }}
                />
              ))}
            </div>
            <Lock className="h-3 w-3 shrink-0 text-neon-cyan/60" />
          </div>

          {/* Stop & send button */}
          <button
            type="button"
            onClick={() => void stopRecording(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-neon-cyan bg-black text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            title={t('common.send')}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* --- Normal input row (hidden when locked) --- */}
      <div className={`flex items-center gap-2 ${isRecordingUI && recordLocked ? 'hidden' : ''}`}>
        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40 transition-colors"
          disabled={disabled || isRecordingUI}
          onClick={handleAttachClick}
          title={t('chat.attachFile')}
        >
          <Paperclip className="h-4 w-4" />
        </button>

        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40 transition-colors"
          disabled={disabled || isRecordingUI}
          onClick={() => setEmojiOpen((o) => !o)}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          title={t('emoji.pickerToggle')}
        >
          <Smile className="h-4 w-4" />
        </button>

        <div className="relative flex-1">
          <div
            className={`flex items-center gap-2 rounded border px-3 py-2 ${
              isRecordingUI
                ? 'border-neon-red/70 bg-zinc-950'
                : 'border-neon-cyan/40 bg-black'
            }`}
          >
            <textarea
              ref={inputRef}
              rows={1}
              className="terminal-input flex-1 min-h-6 max-h-24 resize-none text-sm bg-transparent text-neon-cyan placeholder-neon-cyan/40 focus:outline-none disabled:cursor-not-allowed"
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
                  if (messageText.trim() && !disabled) {
                    void onSubmit(e as unknown as React.FormEvent)
                  }
                }
                if (e.key === 'Escape' && replyTo) {
                  setReplyTo(null)
                }
              }}
              onPaste={handlePaste}
              disabled={disabled || isRecordingUI}
              placeholder={isRecordingUI ? t('media.recording') : t('chat.inputPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
            {isRecordingUI && !recordLocked ? (
              <span className="inline-flex items-center gap-1.5 shrink-0">
                {/* Inline circle video preview during hold-to-record */}
                {mediaMode === 'circle' && previewStream ? (
                  <span className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded-full border border-neon-red">
                    <video
                      ref={videoPreviewRef}
                      autoPlay
                      playsInline
                      muted
                      className="h-full w-full object-cover"
                    />
                  </span>
                ) : null}
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-600 animate-pulse" />
                <span className="font-mono text-[10px] text-red-400 tabular-nums">
                  {formatRecordTime(recordSeconds)}
                </span>
                {/* Swipe up hint */}
                {swipeOffsetY > 10 ? (
                  <Lock className="h-3 w-3 text-neon-cyan animate-bounce" />
                ) : (
                  <span className="font-mono text-[8px] text-zinc-500 uppercase">
                    {t('media.swipeHint')}
                  </span>
                )}
              </span>
            ) : null}
          </div>
          {/* Cancel slide overlay */}
          {isRecordingUI && !recordLocked && swipeOffsetX > 20 ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-red-950/80 border border-neon-red/50 rounded transition-opacity"
              style={{ opacity: Math.min(1, swipeOffsetX / CANCEL_THRESHOLD_X) }}
            >
              <span className="font-mono text-[10px] text-neon-red uppercase tracking-widest">
                {t('media.slideCancel')}
              </span>
            </div>
          ) : null}
        </div>

        {/* Mode toggle: small button to switch voice/circle */}
        <button
          type="button"
          className={`shrink-0 border bg-black px-1.5 py-1.5 transition-all disabled:opacity-40 ${
            mediaMode === 'voice'
              ? 'border-zinc-600 text-zinc-400 hover:text-neon-red hover:border-neon-red/50'
              : 'border-neon-red/50 text-neon-red hover:text-neon-cyan hover:border-neon-cyan/50'
          }`}
          disabled={disabled || isRecordingUI}
          onClick={() => setMediaMode((prev) => (prev === 'voice' ? 'circle' : 'voice'))}
          title={mediaMode === 'voice' ? t('media.switchToCircle') : t('media.switchToVoice')}
        >
          {mediaMode === 'voice' ? (
            <Video className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Record button: hold to record */}
        <button
          type="button"
          className={`shrink-0 select-none border bg-black px-3 py-2 transition-all disabled:opacity-40 ${
            isRecordingUI
              ? 'border-red-600 bg-red-950/20 text-red-300'
              : mediaMode === 'voice'
              ? 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10'
              : 'border-neon-red text-neon-red hover:bg-neon-red/10'
          }`}
          disabled={disabled || !cryptoCtx}
          onContextMenu={handleContextMenu}
          onPointerDown={handleRecordPointerDown}
          onPointerMove={handleRecordPointerMove}
          onPointerUp={handleRecordPointerUp}
          onPointerCancel={handleRecordPointerUp}
          title={mediaMode === 'voice' ? t('media.holdVoice') : t('media.holdCircle')}
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

        <button
          type="submit"
          disabled={disabled || !messageText.trim() || isRecordingUI}
          className="min-h-11 min-w-[44px] shrink-0 px-3 py-2 md:min-h-0 md:min-w-0 border border-neon-cyan bg-black text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40 transition-colors"
          title={t('common.send')}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}

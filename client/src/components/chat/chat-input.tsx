'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, Paperclip, Smile, Mic, Video } from 'lucide-react'
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

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  const {
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
  } = useMediaRecorder()

  useEffect(() => {
    if (!emojiOpen) return
    const close = () => setEmojiOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  // Cleanup recording timer on unmount
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
    }
  }, [])

  const toggleMediaMode = () => {
    if (isRecordingRef.current) return
    setMediaMode((prev) => (prev === 'voice' ? 'circle' : 'voice'))
  }

  const startRecording = async () => {
    if (!cryptoCtx || disabled || isRecordingRef.current) return

    isRecordingRef.current = true
    setIsRecordingUI(true)
    setRecordSeconds(0)
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
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
    }
  }

  const stopRecording = async () => {
    if (!isRecordingRef.current) return

    isRecordingRef.current = false
    setIsRecordingUI(false)
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }

    try {
      const result = await stopCapture()
      if (result && result.blob.size > 0 && cryptoCtx) {
        await sendMedia(
          result.blob,
          mediaMode === 'voice' ? 'audio' : 'video'
        )
      } else {
        console.warn('Capture stopped but blob is empty or null.')
      }
    } catch (error) {
      console.error('Failed to stop recording:', error)
    }
  }

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
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
  }

  return (
    <form
      ref={containerRef}
      onSubmit={(e) => void onSubmit(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative shrink-0 touch-manipulation border-t border-neon-cyan/40 bg-black p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-colors duration-200 data-[drag-over=true]:bg-neon-cyan/5"
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

      <div className="flex items-center gap-2">
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
              className="terminal-input flex-1 min-h-6 max-h-24 resize-none text-sm bg-transparent text-neon-cyan placeholder-neon-cyan/40 focus:outline-none disabled:cursor-not-allowed"
              value={messageText}
              onChange={(e) => {
                const next = e.target.value
                setMessageText(next)
                onDraftChanged(next)
              }}
              onPaste={handlePaste}
              disabled={disabled || isRecordingUI}
              placeholder={isRecordingUI ? t('media.recording') : t('chat.inputPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
            {isRecordingUI ? (
              <span className="inline-flex items-center gap-1.5 shrink-0">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-600 animate-pulse" />
                <span className="font-mono text-[10px] text-red-400 tabular-nums">
                  {formatRecordTime(recordSeconds)}
                </span>
              </span>
            ) : null}
          </div>
        </div>

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
          onClick={(e) => {
            e.preventDefault()
            if (!isRecordingRef.current) toggleMediaMode()
          }}
          onPointerDown={(e) => {
            if (disabled || !cryptoCtx) return
            e.preventDefault()
            void startRecording()
          }}
          onPointerUp={(e) => {
            e.preventDefault()
            void stopRecording()
          }}
          onPointerCancel={(e) => {
             e.preventDefault()
             void stopRecording()
          }}
          title={mediaMode === 'voice' ? t('media.holdVoice') : t('media.holdCircle')}
          style={{ touchAction: 'none' }}
        >
          {isRecordingUI ? (
            <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
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
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}

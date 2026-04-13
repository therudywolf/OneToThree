'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { useTranslation } from '@/hooks/use-translation'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { resumeAudioContextAfterGesture } from '@/lib/call-ringtones'
import { vibrateShort } from '@/lib/vibrate'
import EmojiPicker from 'emoji-picker-react'

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
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
  cryptoCtx: Record<string, unknown>
  disabled?: boolean
}

export function ChatInput({ sendText, sendMedia, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const [messageText, setMessageText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [mediaMode, setMediaMode] = useState<'voice' | 'circle'>('voice')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  const {
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
  } = useMediaRecorder()

  // Close emoji picker on outside click
  useEffect(() => {
    if (!emojiOpen) return
    const close = () => setEmojiOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  const toggleMediaMode = () => {
    if (isRecording) return
    setMediaMode((prev) => (prev === 'voice' ? 'circle' : 'voice'))
  }

  const startRecording = async () => {
    if (!cryptoCtx || disabled || isRecording) return

    setIsRecording(true)
    setRecordingTime(0)
    vibrateShort(12)

    recordingTimerRef.current = setInterval(() => {
      setRecordingTime((time) => time + 1)
    }, 1000)

    try {
      if (mediaMode === 'voice') {
        await startVoiceCapture()
      } else {
        await startVideoCircleCapture()
      }
      await resumeAudioContextAfterGesture()
    } catch (error) {
      console.error('Failed to start recording:', error)
      setIsRecording(false)
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
        recordingTimerRef.current = null
      }
    }
  }

  const stopRecording = async () => {
    if (!isRecording) return

    setIsRecording(false)
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }

    try {
      const result = await stopCapture()
      if (result && cryptoCtx) {
        await sendMedia(
          result.blob,
          mediaMode === 'voice' ? 'audio' : 'video'
        )
      }
    } catch (error) {
      console.error('Failed to stop recording:', error)
    }
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
        } catch {
          /* ignore */
        }
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
    if (containerRef.current) {
      containerRef.current.classList.add('drag-over')
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (containerRef.current) {
      containerRef.current.classList.remove('drag-over')
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (containerRef.current) {
      containerRef.current.classList.remove('drag-over')
    }

    if (!e.dataTransfer?.files.length) return

    for (const file of e.dataTransfer.files) {
      if (isImageFile(file)) {
        await sendMedia(file, 'image')
      }
    }
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return

    for (const file of e.target.files) {
      if (isImageFile(file)) {
        await sendMedia(file, 'image')
      }
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
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        aria-label={t('chat.attachFile') || 'Attach file'}
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
            previewConfig={{
              showPreview: false,
            }}
            width={300}
            height={350}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40"
          disabled={disabled || isRecording}
          onClick={handleAttachClick}
          aria-label={t('chat.attachFile') || 'Attach file'}
        >
          📎
        </button>

        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40"
          disabled={disabled || isRecording}
          onClick={() => setEmojiOpen((o) => !o)}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          aria-label={t('emoji.pickerAria')}
          aria-expanded={emojiOpen}
        >
          😊
        </button>

        <div className="relative flex-1">
          <div
            className={`flex items-center gap-2 rounded border px-3 py-2 ${
              isRecording
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
              disabled={disabled || isRecording}
              aria-label={t('chat.inputPlaceholder')}
              placeholder={
                isRecording
                  ? 'RECORDING...'
                  : t('chat.inputPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
            />
            {isRecording ? (
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-600 animate-pulse" />
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className={`shrink-0 border bg-black px-3 py-2 font-mono text-[10px] uppercase tracking-widest hover:bg-opacity-10 disabled:opacity-40 transition-all ${
            isRecording
              ? 'border-red-600 bg-red-950/20 text-red-300'
              : mediaMode === 'voice'
              ? 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10'
              : 'border-neon-red text-neon-red hover:bg-neon-red/10'
          }`}
          disabled={disabled || !cryptoCtx}
          onClick={() => {
            if (!isRecording) toggleMediaMode()
          }}
          onMouseDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            void startRecording()
          }}
          onMouseUp={async () => {
            if (!isRecording) return
            await stopRecording()
          }}
          onTouchStart={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            void startRecording()
          }}
          onTouchEnd={async () => {
            if (!isRecording) return
            await stopRecording()
          }}
          style={{ touchAction: 'none' }}
          title={
            isRecording
              ? 'Stop recording'
              : mediaMode === 'voice'
              ? 'Voice mode (hold to record, tap to switch)'
              : 'Circle mode (hold to record, tap to switch)'
          }
        >
          {isRecording ? '●' : mediaMode === 'voice' ? '🎤' : '📹'}
        </button>

        <TerminalGlitchButton
          type="submit"
          disabled={disabled || !messageText.trim() || isRecording}
          className="min-h-11 min-w-[44px] shrink-0 px-4 py-2 md:min-h-0 md:min-w-0"
        >
          [ TX ]
        </TerminalGlitchButton>
      </div>
    </form>
  )
}

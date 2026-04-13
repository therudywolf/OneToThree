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

type BurnPreset = 'off' | '1m' | '1h' | '24h'

function burnIsoFromPreset(preset: BurnPreset): string | null {
  if (preset === 'off') return null
  const addMs =
    preset === '1m'
      ? 60_000
      : preset === '1h'
        ? 3_600_000
        : 86_400_000
  return new Date(Date.now() + addMs).toISOString()
}

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
  const [burnPreset, setBurnPreset] = useState<BurnPreset>('off')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  // Media recording state
  const [mediaMode, setMediaMode] = useState<'voice' | 'video'>('voice')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const recordingHeldRef = useRef(false)
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)

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
    setMediaMode(prev => prev === 'voice' ? 'video' : 'voice')
  }

  const startRecording = async () => {
    if (!cryptoCtx || disabled) return

    setIsRecording(true)
    setRecordingTime(0)
    vibrateShort(12)

    // Start recording timer
    recordingTimerRef.current = setInterval(() => {
      setRecordingTime(t => t + 1)
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
    const burn_at = burnIsoFromPreset(burnPreset)
    await sendText(messageText, replyTo?.id ?? null, {
      burn_at: burn_at ?? undefined,
    })
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

      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-neon-cyan/90">
        <span className="text-neon-red/90">{t('chat.burnTimerLabel')}</span>
        <select
          value={burnPreset}
          onChange={(e) => setBurnPreset(e.target.value as BurnPreset)}
          disabled={disabled}
          className="max-w-[140px] border border-neon-cyan/40 bg-black px-1 py-0.5 text-[9px] text-neon-cyan"
          aria-label={t('chat.burnTimerLabel')}
        >
          <option value="off">OFF</option>
          <option value="1m">1m</option>
          <option value="1h">1h</option>
          <option value="24h">24h</option>
        </select>
      </div>

      {/* Main input row */}
      <div className="flex items-center gap-2">
        {/* LEFT: Attach button */}
        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 hover:border-neon-cyan disabled:opacity-40"
          disabled={disabled || isRecording}
          onClick={handleAttachClick}
          aria-label={t('chat.attachFile') || 'Attach file'}
        >
          📎
        </button>

        {/* LEFT: Emoji button */}
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

        {/* CENTER: Text input or Recording state */}
        {isRecording ? (
          <div className="flex flex-1 items-center justify-between gap-2 border border-neon-red/60 bg-black/80 px-3 py-2">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-neon-red" />
            <span className="flex-1 font-mono text-sm text-neon-red">
              {mediaMode === 'voice' ? '🎤 RECORDING...' : '📹 RECORDING'}
            </span>
            <span className="font-mono text-xs text-neon-cyan">
              {String(Math.floor(recordingTime / 60)).padStart(2, '0')}:{String(recordingTime % 60).padStart(2, '0')}
            </span>
            <span className="text-[9px] text-zinc-500 whitespace-nowrap">slide ⬅ cancel</span>
          </div>
        ) : (
          <div className="flex flex-1 items-center gap-1 border border-neon-cyan/40 bg-black px-2 py-1.5">
            <span className="shrink-0 select-none font-mono text-[9px] text-neon-cyan/70">&gt;_</span>
            <textarea
              ref={inputRef}
              className="terminal-input flex-1 min-h-6 max-h-24 resize-none text-sm bg-transparent text-neon-cyan placeholder-neon-cyan/40 focus:outline-none"
              value={messageText}
              onChange={(e) => {
                const next = e.target.value
                setMessageText(next)
                onDraftChanged(next)
              }}
              onPaste={handlePaste}
              disabled={disabled}
              aria-label={t('chat.inputPlaceholder')}
              placeholder={t('chat.inputPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        {/* RIGHT: Unified media button */}
        <button
          type="button"
          className={`shrink-0 border bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest hover:bg-opacity-10 disabled:opacity-40 transition-all ${
            mediaMode === 'voice'
              ? 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan'
              : 'border-neon-red text-neon-red hover:bg-neon-red'
          }`}
          disabled={disabled || !cryptoCtx}
          onClick={toggleMediaMode}
          onMouseDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            recordingHeldRef.current = true
            void startRecording()
          }}
          onMouseUp={async () => {
            if (!recordingHeldRef.current) return
            recordingHeldRef.current = false
            await stopRecording()
          }}
          onMouseLeave={async () => {
            if (!recordingHeldRef.current) return
            recordingHeldRef.current = false
            await stopRecording()
          }}
          onTouchStart={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            recordingHeldRef.current = true
            void startRecording()
          }}
          onTouchEnd={async () => {
            if (!recordingHeldRef.current) return
            recordingHeldRef.current = false
            await stopRecording()
          }}
          style={{ touchAction: 'none' }}
          title={mediaMode === 'voice' ? 'Voice (hold to record)' : 'Video (hold to record)'}
        >
          {isRecording ? (
            <span className="inline-block animate-pulse text-base">●</span>
          ) : mediaMode === 'voice' ? (
            '🎤'
          ) : (
            '📹'
          )}
        </button>

        {/* RIGHT: Send button */}
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

'use client'

import { useEffect, useRef, useState } from 'react'
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
  cryptoCtx: any // ChatCryptoContext
  disabled?: boolean
}

/** Curated grid — lightweight, no heavy emoji font bundle */
const EMOJI_PRESET = [
  '😀',
  '😅',
  '😐',
  '🙂',
  '😈',
  '👍',
  '👎',
  '🔥',
  '💀',
  '⚡',
  '✨',
  '🖤',
  '❤️',
  '✅',
  '❌',
  '❓',
  '⚠️',
  '➡️',
  '📎',
  '🔐',
]

export function ChatInput({ sendText, sendMedia, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [burnPreset, setBurnPreset] = useState<BurnPreset>('off')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  // Media recording state
  const [mediaMode, setMediaMode] = useState<'mic' | 'camera'>('mic')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingStartTime, setRecordingStartTime] = useState(0)
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)

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

  useEffect(() => {
    if (isRecording) {
      recordingTimerRef.current = setInterval(() => {
        // Update timer visual feedback
      }, 100)
    } else {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
        recordingTimerRef.current = null
      }
    }
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
      }
    }
  }, [isRecording, recordingStartTime])

  const toggleMediaMode = () => {
    setMediaMode(prev => prev === 'mic' ? 'camera' : 'mic')
  }

  const startRecording = async () => {
    if (!cryptoCtx || disabled) return

    setIsRecording(true)
    setRecordingStartTime(Date.now())
    vibrateShort(12)

    try {
      if (mediaMode === 'mic') {
        await startVoiceCapture()
      } else {
        await startVideoCircleCapture()
      }
      await resumeAudioContextAfterGesture()
    } catch (error) {
      console.error('Failed to start recording:', error)
      setIsRecording(false)
    }
  }

  const stopRecording = async () => {
    if (!isRecording) return

    setIsRecording(false)
    try {
      const result = await stopCapture()
      if (result && cryptoCtx) {
        await sendMedia(
          result.blob,
          mediaMode === 'mic' ? 'audio' : 'video'
        )
      }
    } catch (error) {
      console.error('Failed to stop recording:', error)
    }
  }

  function insertEmoji(ch: string) {
    setValue((prev) => {
      const el = inputRef.current
      let next: string
      if (!el) {
        next = prev + ch
      } else {
        const start = el.selectionStart ?? prev.length
        const end = el.selectionEnd ?? prev.length
        next = prev.slice(0, start) + ch + prev.slice(end)
        queueMicrotask(() => {
          const pos = start + ch.length
          el.focus()
          try {
            el.setSelectionRange(pos, pos)
          } catch {
            /* ignore */
          }
        })
      }
      onDraftChanged(next)
      return next
    })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || disabled) return
    const burn_at = burnIsoFromPreset(burnPreset)
    await sendText(value, replyTo?.id ?? null, {
      burn_at: burn_at ?? undefined,
    })
    onSubmitOrClear()
    setValue('')
    setReplyTo(null)
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="relative shrink-0 touch-manipulation border-t border-neon-cyan/40 bg-black p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
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
            theme="dark"
            skinTonesDisabled
            searchDisabled
            previewConfig={{
              showPreview: false
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
          disabled={disabled}
          aria-label={t('emoji.pickerAria')}
          aria-expanded={emojiOpen}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={() => setEmojiOpen((o) => !o)}
        >
          [ {t('emoji.pickerToggle')} ]
        </button>
        <button
          type="button"
          className={`shrink-0 border bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest hover:bg-opacity-10 disabled:opacity-40 ${
            mediaMode === 'mic'
              ? 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan'
              : 'border-neon-red text-neon-red hover:bg-neon-red'
          }`}
          disabled={disabled || !cryptoCtx}
          onClick={toggleMediaMode}
          onMouseDown={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            startRecording()
          }}
          onMouseUp={stopRecording}
          onTouchStart={(e) => {
            if (disabled || !cryptoCtx || isRecording) return
            e.preventDefault()
            startRecording()
          }}
          onTouchEnd={stopRecording}
          style={{ touchAction: 'none' }}
        >
          {isRecording ? (
            <span className="animate-pulse">●</span>
          ) : mediaMode === 'mic' ? (
            '🎤'
          ) : (
            '📷'
          )}
        </button>
        <span className="shrink-0 select-none font-mono text-neon-cyan">&gt;_</span>
        <input
          ref={inputRef}
          className="terminal-input flex-1 text-sm"
          value={value}
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            onDraftChanged(next)
          }}
          disabled={disabled}
          aria-label={t('chat.inputPlaceholder')}
          placeholder={t('chat.inputPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <TerminalGlitchButton
          type="submit"
          disabled={disabled || !value.trim()}
          className="min-h-11 min-w-[44px] shrink-0 px-4 py-2 md:min-h-0 md:min-w-0"
        >
          [ TX ]
        </TerminalGlitchButton>
      </div>
    </form>
  )
}

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
import type { AttachmentKind } from '@/lib/attachment-envelope'
import { toastError } from '@/store/toastStore'
import {
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
  MEDIA_TOO_LARGE_CODE,
} from '@/lib/media-limits'
import dynamic from 'next/dynamic'
import { Theme } from 'emoji-picker-react'
import { MediaPreviewModal } from '@/components/chat/media-preview-modal'
import { useDockStore, matchesDockViewport } from '@/store/dockStore'

const LazyEmojiPicker = dynamic(
  () => import('emoji-picker-react').then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[350px] w-[300px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
        loading…
      </div>
    ),
  }
)

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
    options?: { fileName?: string; fileType?: string; kind?: AttachmentKind }
  ) => Promise<void>
  sendAlbum?: (
    items: Array<{
      blob: Blob
      segmentClass: 'audio' | 'video' | 'image' | 'file'
      options?: { label?: string; mime?: string; kind?: AttachmentKind }
    }>,
    caption?: string
  ) => Promise<void>
  cryptoCtx: ChatCryptoContext | null
  disabled?: boolean
}

type QueuedFile = { file: File; mediaType: 'image' | 'video' | 'audio' | 'file' }

export function ChatInput({ sendText, sendMedia, sendAlbum, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const [messageText, setMessageText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)

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
  const [mediaMode, setMediaMode] = useState<'voice' | 'circle'>('voice')

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isHoldRef = useRef(false)

  const [fileQueue, setFileQueue] = useState<QueuedFile[]>([])
  const previewFile = fileQueue[0] ?? null
  const sendingTextRef = useRef(false)
  const [sendingText, setSendingText] = useState(false)
  const sendingMediaRef = useRef(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiContainerRef = useRef<HTMLDivElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const editingMessage = useChatStore((s) => s.editingMessage)
  const setEditingMessage = useChatStore((s) => s.setEditingMessage)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  // When a message is staged for editing, load its plaintext into the
  // composer and switch submit into "save edit" mode.
  useEffect(() => {
    if (editingMessage?.plaintext) {
      setMessageText(editingMessage.plaintext)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 96)}px`
        const pos = editingMessage.plaintext!.length
        try { el.setSelectionRange(pos, pos) } catch { /* noop */ }
      })
    }
  }, [editingMessage])

  const {
    startVoiceCapture,
    startVideoCircleCapture,
    stopCapture,
    previewStream,
    error: recorderError,
    clearError: clearRecorderError,
  } = useMediaRecorder()

  // Surface recorder errors (permission denied, too-large, no MediaRecorder) to the user.
  useEffect(() => {
    if (!recorderError) return
    const message =
      recorderError === MEDIA_PERMISSION_DENIED_CODE
        ? 'Microphone/camera access denied. Grant permission in browser settings.'
        : recorderError === MEDIA_TOO_LARGE_CODE
        ? 'Recording exceeds the size limit.'
        : recorderError === MEDIA_ACCESS_ERROR_MESSAGE
        ? 'Media devices not available in this browser.'
        : `Recorder error: ${recorderError}`
    toastError(message, { title: 'RECORDING' })
    clearRecorderError()
  }, [recorderError, clearRecorderError])

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
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
    }
  }, [])

  // Global pointerup fallback. Even with setPointerCapture, some browsers
  // (Safari desktop on release builds, Chromium when dev-tools fires an
  // implicit pointercancel) fail to deliver pointerup back to the mic
  // button. We therefore install a window-level listener while recording
  // is active, so releasing the mouse/finger ANYWHERE in the window still
  // stops + sends the recording instead of leaving it running forever.
  useEffect(() => {
    if (!isRecordingUI || recordLocked) return
    const onGlobalUp = () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      if (isRecordingRef.current && !recordLocked) {
        void stopRecording(true)
      }
    }
    window.addEventListener('pointerup', onGlobalUp)
    window.addEventListener('pointercancel', onGlobalUp)
    window.addEventListener('mouseup', onGlobalUp)
    return () => {
      window.removeEventListener('pointerup', onGlobalUp)
      window.removeEventListener('pointercancel', onGlobalUp)
      window.removeEventListener('mouseup', onGlobalUp)
    }
    // stopRecording changes identity between renders; we only want to
    // (re-)install the listener when the RECORDING state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecordingUI, recordLocked])

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
      if (!shouldSend) return
      if (!result || result.blob.size === 0) {
        if (shouldSend) toastError('Recording was empty — nothing to send.', { title: 'RECORDING' })
        return
      }
      if (!cryptoCtx) {
        toastError('E2E context not ready — try again.', { title: 'RECORDING' })
        return
      }
      const isVoice = mediaMode === 'voice'
      const kind: AttachmentKind = isVoice ? 'voice' : 'video_circle'
      const prefix = isVoice ? 'voice-note' : 'video-circle'
      const labelName = `${prefix}-${Date.now()}`
      await sendMedia(
        result.blob,
        isVoice ? 'audio' : 'video',
        undefined,
        { fileType: result.mimeType, fileName: labelName, kind }
      )
    } catch (error) {
      // `sendMedia` already surfaces a toast; avoid double-notifying here.
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

  const handleAttachClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    setFileQueue(Array.from(e.target.files).map((file) => ({ file, mediaType: detectMediaType(file) })))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const canAlbum = (items: QueuedFile[]) =>
    items.length >= 2 &&
    items.length <= 10 &&
    items.every((it) => it.mediaType === 'image' || it.mediaType === 'video')

  const handlePreviewSend = useCallback(async (caption: string) => {
    if (sendingMediaRef.current || fileQueue.length === 0) return
    sendingMediaRef.current = true
    try {
      if (sendAlbum && canAlbum(fileQueue)) {
        await sendAlbum(
          fileQueue.map((it) => ({
            blob: it.file,
            segmentClass: it.mediaType,
            options: { label: it.file.name, mime: it.file.type },
          })),
          caption || undefined,
        )
        setFileQueue([])
        return
      }
      const item = fileQueue[0]
      if (!item) return
      await sendMedia(item.file, item.mediaType, caption || undefined, {
        fileName: item.file.name,
        fileType: item.file.type,
      })
      setFileQueue((prev) => prev.slice(1))
    } finally {
      sendingMediaRef.current = false
    }
  }, [sendMedia, sendAlbum, fileQueue])

  const handlePreviewCancel = useCallback(() => setFileQueue([]), [])
  const handleRemoveFromQueue = useCallback((index: number) => {
    setFileQueue((prev) => prev.filter((_, i) => i !== index))
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!messageText.trim() || disabled || sendingTextRef.current) return
    sendingTextRef.current = true
    setSendingText(true)
    try {
      if (editingMessage) {
        await submitEdit(editingMessage.id, messageText)
      } else {
        await sendText(messageText, replyTo?.id ?? null)
      }
      onSubmitOrClear()
      setMessageText('')
      setReplyTo(null)
      setEditingMessage(null)
      if (inputRef.current) {
        inputRef.current.style.height = 'auto'
        inputRef.current.focus()
      }
    } finally {
      sendingTextRef.current = false
      setSendingText(false)
    }
  }

  // Edit existing message over REST. Server re-encrypts with the same session
  // key on its side if needed. We optimistically update via the chat store
  // when the server accepts.
  async function submitEdit(messageId: string, newText: string) {
    try {
      const { API_URL } = await import('@/lib/api/auth')
      const res = await fetch(`${API_URL}/messages/${messageId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plaintext: newText }),
      })
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string }
        toastError(error ?? 'EDIT_FAILED', { title: 'EDIT' })
      }
    } catch {
      toastError('Network error during edit.', { title: 'EDIT' })
    }
  }

  // Explicit send handler for mobile — single onClick, no onTouchEnd to avoid double-fire
  const handleSendClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (!messageText.trim() || disabled || sendingTextRef.current) return
    sendingTextRef.current = true
    setSendingText(true)
    const task = editingMessage
      ? submitEdit(editingMessage.id, messageText)
      : sendText(messageText, replyTo?.id ?? null)
    void task
      .then(() => {
        onSubmitOrClear()
        setMessageText('')
        setReplyTo(null)
        setEditingMessage(null)
        if (inputRef.current) {
          inputRef.current.style.height = 'auto'
          inputRef.current.focus()
        }
      })
      .finally(() => {
        sendingTextRef.current = false
        setSendingText(false)
      })
  }, [messageText, disabled, sendText, replyTo, onSubmitOrClear, setReplyTo, editingMessage, setEditingMessage])

  const handleContextMenu = (e: React.MouseEvent) => e.preventDefault()

  const handleRecordPointerDown = (e: React.PointerEvent) => {
    if (disabled || !cryptoCtx) return
    e.preventDefault()
    // If user TAPS the mic button while already recording (unlocked mode),
    // treat the tap as "stop + send". Telegram on desktop does the same —
    // click once to start, click again to stop.  Before, we only reacted to
    // pointerup, which meant a click without hold did nothing useful.
    if (isRecordingRef.current && !recordLocked) {
      void stopRecording(true)
      return
    }
    // Capture the pointer so pointerup still fires on this button even if
    // the cursor leaves the 40×40 hit box (very common on desktop). Without
    // this, pointerup goes to whatever element is under the cursor and the
    // recording stays alive forever — exactly the "висит стоп, отправить
    // не могу" symptom.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* Safari < 16 throws on setPointerCapture for non-primary pointers —
         we rely on the window-level fallback below. */
    }
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

  const showSendOnMobile = messageText.trim().length > 0

  return (
    <form
      ref={containerRef}
      onSubmit={(e) => void onSubmit(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="p13-composer chat-compose-shell sticky bottom-0 z-10 shrink-0 touch-manipulation p-2 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]"
      style={{
        paddingBottom:
          'calc(max(0.5rem, env(safe-area-inset-bottom)) + var(--p13-keyboard-inset, 0px))',
      }}
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

      {replyTo && !editingMessage ? (
        <div className="p13-reply-banner">
          <p className="p13-reply-banner-text">
            ↳ {t('chat.replyBanner')}:{' '}
            {replyTo.plaintext ? replyTo.plaintext.slice(0, 80) : '[MEDIA]'}
          </p>
          <button type="button" onClick={() => setReplyTo(null)} className="p13-banner-dismiss">[X]</button>
        </div>
      ) : null}

      {editingMessage ? (
        <div className="p13-edit-banner">
          <p className="p13-edit-banner-text">
            {t('msgAction.edit')}: {editingMessage.plaintext?.slice(0, 80) ?? '…'}
          </p>
          <button
            type="button"
            onClick={() => { setEditingMessage(null); setMessageText('') }}
            className="p13-banner-dismiss"
          >
            [X]
          </button>
        </div>
      ) : null}

      {/* Locked recording controls */}
      {isRecordingUI && recordLocked ? (
        <div className="p13-record-bar">
          <button type="button" onClick={() => void cancelRecording()}
            className="p13-icon-btn p13-icon-btn--danger shrink-0"
            title={t('common.cancel')}>
            <X className="h-4 w-4" />
          </button>
          {mediaMode === 'circle' && previewStream ? (
            <div className="relative aspect-square w-16 shrink-0 overflow-hidden rounded-full border-2 border-danger bg-void">
              <video ref={videoPreviewRef} autoPlay playsInline muted className="h-full w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 bg-void/60 text-center font-mono text-[7px] text-danger">{formatRecordTime(recordSeconds)}</span>
            </div>
          ) : null}
          <div className="p13-record-waveform">
            <span className="inline-flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger/60" />
            <span className="shrink-0 font-[family-name:var(--p13-font-body)] text-[10px] tabular-nums text-danger/80">{formatRecordTime(recordSeconds)}</span>
            <div className="flex h-6 flex-1 items-end gap-[1px]">
              {waveformBars.map((h, i) => (
                <div key={i} className="min-w-[2px] flex-1 bg-danger/70 transition-all duration-150" style={{ height: `${Math.round(h * 100)}%`, borderRadius: 'var(--p13-radius-msg)' }} />
              ))}
            </div>
            <Lock className="h-3 w-3 shrink-0 text-neon-cyan/60" />
          </div>
          <button type="button" onClick={() => void stopRecording(true)}
            className="p13-icon-btn p13-icon-btn--primary shrink-0"
            title={t('common.send')}>
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Normal input row */}
      <div className={`flex items-center gap-2 ${isRecordingUI && recordLocked ? 'hidden' : ''}`}>

        {/* Emoji button — left side, next to attach */}
        {!isRecordingUI ? (
          <div ref={emojiContainerRef} className="relative shrink-0">
            <button
              type="button"
              className="p13-icon-btn"
              disabled={disabled}
              onClick={() => {
                // On xl+ viewports open the shared right-dock emoji slot
                // so the picker persists as the user scrolls/searches.
                if (matchesDockViewport()) {
                  const store = useDockStore.getState()
                  if (store.slot === 'emoji') {
                    store.close()
                  } else {
                    store.openEmoji((emoji) => insertEmoji(emoji))
                  }
                  return
                }
                setEmojiOpen((o) => !o)
              }}
              tabIndex={-1}
              title={t('emoji.pickerToggle')}
            >
              <Smile className="h-4 w-4" />
            </button>
            {emojiOpen && (
              <div className="p13-emoji-popup">
                <LazyEmojiPicker
                  onEmojiClick={(emojiData: { emoji: string }) => { insertEmoji(emojiData.emoji); setEmojiOpen(false) }}
                  skinTonesDisabled
                  searchDisabled
                  previewConfig={{ showPreview: false }}
                  width={300}
                  height={350}
                  theme={Theme.DARK}
                />
              </div>
            )}
          </div>
        ) : null}

        {/* Attach — always opens file picker directly */}
        <div className="relative shrink-0">
          <button
            type="button"
            className="p13-icon-btn"
            disabled={disabled || isRecordingUI}
            onClick={handleAttachClick}
            title={t('chat.attachFile')}
          >
            <Paperclip className="h-4 w-4" />
          </button>
        </div>

        {/* Input field */}
        <div className="relative flex-1">
          <div
            className={`p13-composer-input relative ${
              isRecordingUI ? 'ring-1 ring-danger/40' : ''
            }`}
          >
            <textarea
              ref={inputRef}
              rows={1}
              className="flex-1 min-h-6 max-h-24 resize-none bg-transparent border-0 outline-none text-[color:var(--on-surface)] placeholder:text-[color:var(--text-muted)] disabled:cursor-not-allowed"
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
                  if (messageText.trim() && !disabled && !sendingTextRef.current) void onSubmit(e as unknown as React.FormEvent)
                }
                if (e.key === 'Escape' && replyTo) setReplyTo(null)
              }}
              onPaste={handlePaste}
              disabled={disabled || isRecordingUI || sendingText}
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
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-danger/30 animate-pulse" />
                <span className="font-mono text-[10px] text-danger/80 tabular-nums">{formatRecordTime(recordSeconds)}</span>
                {swipeOffsetY > 10 ? (
                  <Lock className="h-3 w-3 text-neon-cyan animate-bounce" />
                ) : (
                  <span className="font-mono text-[8px] text-text-muted uppercase">{t('media.swipeHint')}</span>
                )}
              </span>
            ) : null}
          </div>

          {isRecordingUI && !recordLocked && swipeOffsetX > 20 ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-danger/30 border border-neon-red/50 rounded transition-opacity"
              style={{ opacity: Math.min(1, swipeOffsetX / CANCEL_THRESHOLD_X) }}
            >
              <span className="font-mono text-[10px] text-neon-red uppercase tracking-widest">{t('media.slideCancel')}</span>
            </div>
          ) : null}
        </div>

        {/* Record button — hidden when text is present (Telegram-style mic↔send morph) */}
        <button
          type="button"
          className={`p13-icon-btn shrink-0 select-none ${
            isRecordingUI
              ? 'p13-icon-btn--danger'
              : mediaMode === 'voice'
              ? 'p13-icon-btn--primary'
              : 'p13-icon-btn--danger'
          } ${showSendOnMobile ? 'hidden' : 'inline-flex'}`}
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
            <Square className="h-3.5 w-3.5 fill-danger text-danger/80" />
          ) : mediaMode === 'voice' ? (
            <Mic className="h-4 w-4" />
          ) : (
            <Video className="h-4 w-4" />
          )}
        </button>

        {/* Send button — shown only when text is present (Telegram-style mic↔send morph) */}
        <button
          type="button"
          disabled={disabled || !messageText.trim() || isRecordingUI || sendingText}
          className={`p13-icon-btn p13-icon-btn--primary shrink-0 ${
            showSendOnMobile ? 'inline-flex' : 'hidden'
          }`}
          title={t('common.send')}
          onClick={handleSendClick}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}

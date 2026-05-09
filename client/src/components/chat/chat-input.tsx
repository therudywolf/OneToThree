'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Paperclip, Smile, Mic, Video, Lock, X, Square, Flame, BarChart2 } from 'lucide-react'
import { FormatToolbar } from '@/components/chat/format-toolbar'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { parseStickerEnvelope } from '@/lib/attachment-envelope'
import { grantStickerPackToChat } from '@/lib/api/stickers'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { useTranslation } from '@/hooks/use-translation'
import { useMediaRecorder } from '@/hooks/use-media-recorder'
import { resumeAudioContextAfterGesture } from '@/lib/call-ringtones'
import { vibrateShort } from '@/lib/vibrate'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import type { AttachmentKind } from '@/lib/attachment-envelope'
import { toastError } from '@/store/toastStore'
import { loadDraft, saveDraftDebounced, clearDraft } from '@/lib/chat-drafts'
import { createPoll } from '@/lib/api/polls'
import {
  MEDIA_ACCESS_ERROR_MESSAGE,
  MEDIA_PERMISSION_DENIED_CODE,
  MEDIA_TOO_LARGE_CODE,
  describeLimitError,
  validateFileForUpload,
} from '@/lib/media-limits'
import { MediaPreviewModal } from '@/components/chat/media-preview-modal'
import { UploadProgressList } from '@/components/chat/upload-progress-list'
import { ComposerPickerPanel } from '@/components/chat/composer-picker-panel'
import { useDockStore, matchesDockViewport } from '@/store/dockStore'
import type { GifHit } from '@/lib/api/gif'
import { buildGifProxyUrl } from '@/lib/api/gif'
import { useThemeStore } from '@/store/themeStore'
import { TELEGRAM_BEHAVIOR } from '@/components/chat/telegram-behavior'
import {
  MentionsPopover,
  parseMentionTrigger,
  type MentionMember,
} from '@/components/chat/mentions-popover'

function detectMediaType(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

const LOCK_THRESHOLD_Y = TELEGRAM_BEHAVIOR.gestures.recordLockYpx
const CANCEL_THRESHOLD_X = TELEGRAM_BEHAVIOR.gestures.recordCancelXpx
const HOLD_THRESHOLD_MS = TELEGRAM_BEHAVIOR.gestures.recordHoldMs

type Props = {
  sendText: (
    t: string,
    replyToId?: string | null,
    opts?: { burn_duration_secs?: number | null }
  ) => Promise<void>
  sendMedia: (
    blob: Blob,
    mediaType: 'audio' | 'video' | 'image' | 'file',
    caption?: string,
    options?: {
      fileName?: string
      fileType?: string
      kind?: AttachmentKind
      sendOriginal?: boolean
    }
  ) => Promise<void>
  sendAlbum?: (
    items: Array<{
      blob: Blob
      segmentClass: 'audio' | 'video' | 'image' | 'file'
      options?: {
        label?: string
        mime?: string
        kind?: AttachmentKind
        sendOriginal?: boolean
      }
    }>,
    caption?: string
  ) => Promise<void>
  cryptoCtx: ChatCryptoContext | null
  disabled?: boolean
}

type QueuedFile = { file: File; mediaType: 'image' | 'video' | 'audio' | 'file' }

export function ChatInput({ sendText, sendMedia, sendAlbum, cryptoCtx, disabled }: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const [messageText, setMessageText] = useState('')
  const [composerPickerOpen, setComposerPickerOpen] = useState(false)
  const [burnTimerSecs, setBurnTimerSecs] = useState<number | null>(null)
  const [burnMenuOpen, setBurnMenuOpen] = useState(false)
  const burnMenuRef = useRef<HTMLDivElement>(null)

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

  // ── Real audio waveform via AnalyserNode ─────────────────────────────────
  const [waveformBars, setWaveformBars] = useState<number[]>(Array(28).fill(0.15))
  const analyserRef = useRef<AnalyserNode | null>(null)
  const waveformRafRef = useRef<number | null>(null)
  const waveformAudioCtxRef = useRef<AudioContext | null>(null)

  const [fileQueue, setFileQueue] = useState<QueuedFile[]>([])
  const previewFile = fileQueue[0] ?? null
  const sendingTextRef = useRef(false)
  const [sendingText, setSendingText] = useState(false)
  const sendingMediaRef = useRef(false)

  const [formatToolbar, setFormatToolbar] = useState<{ visible: boolean; top: number; left: number }>({
    visible: false,
    top: 0,
    left: 0,
  })

  // ── @mentions autocomplete state ──────────────────────────────────────────
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionTriggerStart, setMentionTriggerStart] = useState(0)
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([])
  // Lazily loaded from the chat detail endpoint when first @ is typed
  const mentionMembersLoadedRef = useRef(false)

  // ── Poll composer state ───────────────────────────────────────────────────
  const [pollModalOpen, setPollModalOpen] = useState(false)
  const [pollQuestion, setPollQuestion] = useState('')
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [pollMultiple, setPollMultiple] = useState(false)
  const [pollAnon, setPollAnon] = useState(false)
  const [pollSending, setPollSending] = useState(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerPickerRef = useRef<HTMLDivElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const editingMessage = useChatStore((s) => s.editingMessage)
  const setEditingMessage = useChatStore((s) => s.setEditingMessage)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()
  const activeChatId = useSessionStore((s) => s.activeChatId)

  // Best-effort: when sending a sticker JSON envelope, grant the recipient(s)
  // implicit access to the underlying pack so the asset doesn't 403 on their
  // side. Server validates that the caller owns/sees the pack and is in the
  // chat — failure is silently swallowed (sticker still ships).
  const sendSticker = useCallback(
    async (json: string) => {
      const env = parseStickerEnvelope(json)
      if (env && activeChatId) {
        void grantStickerPackToChat(env.packId, activeChatId)
      }
      await sendText(json)
    },
    [activeChatId, sendText]
  )

  // Load saved draft when the active chat changes (don't overwrite an in-progress edit).
  useEffect(() => {
    if (!activeChatId || editingMessage) return
    const draft = loadDraft(activeChatId)
    setMessageText(draft)
    mentionMembersLoadedRef.current = false // reset on chat switch
  }, [activeChatId])

  // Lazily fetch chat members for @mention autocomplete
  const loadMentionMembers = useCallback(async () => {
    if (!activeChatId || mentionMembersLoadedRef.current) return
    mentionMembersLoadedRef.current = true
    try {
      const { fetchChatDetail } = await import('@/lib/api/chats')
      const detail = await fetchChatDetail(activeChatId)
      setMentionMembers(
        (detail.members ?? []).map((m) => ({
          userId: m.user_id,
          username: m.username ?? m.user_id.slice(0, 8),
          displayName: m.username,
        }))
      )
    } catch {
      // Non-fatal: autocomplete just won't show
    }
  }, [activeChatId])

  // Handle @mention trigger detection when text changes
  const handleMentionCheck = useCallback(
    (text: string, cursorPos: number) => {
      const parsed = parseMentionTrigger(text, cursorPos)
      if (parsed.trigger) {
        void loadMentionMembers()
        setMentionOpen(true)
        setMentionQuery(parsed.query)
        setMentionTriggerStart(parsed.triggerStart)
        setMentionActiveIdx(0)
      } else {
        setMentionOpen(false)
      }
    },
    [loadMentionMembers]
  )

  const handleMentionSelect = useCallback(
    (member: MentionMember) => {
      setMentionOpen(false)
      // Replace the @query fragment with @username
      const before = messageText.slice(0, mentionTriggerStart)
      const after = messageText.slice(
        mentionTriggerStart + 1 + mentionQuery.length // skip '@' + query
      )
      const newText = `${before}@${member.username} ${after}`
      setMessageText(newText)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        const pos = before.length + member.username.length + 2 // '@' + name + ' '
        try { el.setSelectionRange(pos, pos) } catch { /* noop */ }
        el.focus()
      })
    },
    [messageText, mentionTriggerStart, mentionQuery]
  )

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
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`
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
    getStream,
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
    if (!composerPickerOpen) return
    const close = (e: MouseEvent) => {
      if (composerPickerRef.current?.contains(e.target as Node)) return
      setComposerPickerOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [composerPickerOpen])

  useEffect(() => {
    if (!burnMenuOpen) return
    const close = (e: MouseEvent) => {
      if (burnMenuRef.current?.contains(e.target as Node)) return
      setBurnMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [burnMenuOpen])

  /** Returns seconds for burn-after-READ (server sets burn_at at read time). */
  const makeBurnDuration = (secs: number | null): number | null => secs ?? null

  const BURN_OPTIONS: Array<{ secs: number | null; labelKey: string }> = [
    { secs: null,    labelKey: 'chat.burnTimerOff' },
    { secs: 5,       labelKey: 'chat.burnTimer5s'  },
    { secs: 30,      labelKey: 'chat.burnTimer30s' },
    { secs: 60,      labelKey: 'chat.burnTimer1m'  },
    { secs: 3600,    labelKey: 'chat.burnTimer1h'  },
    { secs: 86400,   labelKey: 'chat.burnTimer1d'  },
    { secs: 604800,  labelKey: 'chat.burnTimer1w'  },
  ]

  function formatBurnTimerShort(secs: number | null): string {
    if (!secs) return ''
    if (secs < 60)   return `${secs}s`
    if (secs < 3600) return `${secs / 60}m`
    if (secs < 86400) return `${secs / 3600}h`
    return `${secs / 86400}d`
  }

  useEffect(() => {
    if (!composerPickerOpen) return
    if (!matchesDockViewport()) return
    // Keep one picker surface active after viewport transitions.
    setComposerPickerOpen(false)
  }, [composerPickerOpen])

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
    setWaveformBars(Array(28).fill(0.15))
    try {
      await resumeAudioContextAfterGesture()
      if (mediaMode === 'voice') await startVoiceCapture()
      else await startVideoCircleCapture()
      // Wire AnalyserNode after stream is live (voice only)
      if (mediaMode === 'voice') {
        const stream = getStream()
        if (stream && typeof AudioContext !== 'undefined') {
          try {
            const ctx = new AudioContext()
            const source = ctx.createMediaStreamSource(stream)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 64
            analyser.smoothingTimeConstant = 0.75
            source.connect(analyser)
            analyserRef.current = analyser
            waveformAudioCtxRef.current = ctx
            const buf = new Uint8Array(analyser.frequencyBinCount)
            const tick = () => {
              if (!analyserRef.current) return
              analyserRef.current.getByteFrequencyData(buf)
              const bars = Array.from({ length: 28 }, (_, i) => {
                const binIdx = Math.floor(i * (buf.length / 28))
                return Math.max(0.08, Math.min(1, buf[binIdx] / 200))
              })
              setWaveformBars(bars)
              waveformRafRef.current = requestAnimationFrame(tick)
            }
            waveformRafRef.current = requestAnimationFrame(tick)
          } catch { /* graceful degrade */ }
        }
      }
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
    if (waveformRafRef.current !== null) { cancelAnimationFrame(waveformRafRef.current); waveformRafRef.current = null }
    analyserRef.current = null
    if (waveformAudioCtxRef.current) { void waveformAudioCtxRef.current.close(); waveformAudioCtxRef.current = null }
    setWaveformBars(Array(28).fill(0.15))
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

  const applyFormat = useCallback((tag: string) => {
    const ta = inputRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = ta.value.slice(start, end)
    if (!selected) return
    const wrapped = `${tag}${selected}${tag}`
    const newValue = ta.value.slice(0, start) + wrapped + ta.value.slice(end)
    setMessageText(newValue)
    onDraftChanged(newValue)
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = start + tag.length
      ta.selectionEnd = end + tag.length
    })
    setFormatToolbar((prev) => ({ ...prev, visible: false }))
  }, [onDraftChanged])

  const handleTextareaSelect = useCallback(() => {
    const ta = inputRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) {
      setFormatToolbar((prev) => ({ ...prev, visible: false }))
      return
    }
    // Position toolbar above the textarea
    const rect = ta.getBoundingClientRect()
    const formRect = containerRef.current?.getBoundingClientRect()
    if (!formRect) return
    const relTop = rect.top - formRect.top - 44 // 44px toolbar height + gap
    const relLeft = Math.max(0, rect.left - formRect.left)
    setFormatToolbar({ visible: true, top: relTop, left: relLeft })
  }, [])

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

  const sendGif = useCallback(async (gif: GifHit) => {
    const response = await fetch(buildGifProxyUrl(gif.originalUrl), {
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`GIF_FETCH_${response.status}`)
    }
    const blob = await response.blob()
    const normalizedGifBlob =
      blob.type === 'image/gif' || blob.type === ''
        ? blob
        : new Blob([await blob.arrayBuffer()], { type: 'image/gif' })
    await sendMedia(
      normalizedGifBlob,
      'image',
      undefined,
      {
        fileName: `gif-${gif.id}.gif`,
        fileType: 'image/gif',
      },
    )
  }, [sendMedia])

  /**
   * Sprint M1-3 — validate every incoming file (size by category, image
   * dimensions, video duration) before it joins the queue. Invalid files
   * are dropped with a per-file toast naming the exact reason.
   */
  const acceptIncomingFiles = useCallback(
    async (raw: File[]) => {
      const overflowDropped = Math.max(0, raw.length - ALBUM_HARD_CAP)
      if (overflowDropped > 0) {
        toastError(
          `Max ${ALBUM_HARD_CAP} files per album. ${overflowDropped} dropped.`,
          { title: 'Media' }
        )
      }
      const accepted: QueuedFile[] = []
      for (const file of raw.slice(0, ALBUM_HARD_CAP)) {
        const err = await validateFileForUpload(file)
        if (err) {
          toastError(`${file.name}: ${describeLimitError(err)}`, { title: 'Media' })
          continue
        }
        accepted.push({ file, mediaType: detectMediaType(file) })
      }
      if (accepted.length > 0) setFileQueue(accepted)
    },
    [setFileQueue]
  )

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.files.length) return
    e.preventDefault()
    void acceptIncomingFiles(Array.from(e.clipboardData.files))
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
    void acceptIncomingFiles(Array.from(e.dataTransfer.files))
  }

  const handleAttachClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    void acceptIncomingFiles(Array.from(e.target.files))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // TG-Desktop caps albums at 10; we use 9 because it's the visual sweet spot
  // for the 3x3 grid layout used by AlbumBubble. Larger picks fall back to
  // sequential single sends (no grouping).
  const ALBUM_MAX = 9
  const ALBUM_HARD_CAP = ALBUM_MAX
  const canAlbum = (items: QueuedFile[]) =>
    items.length >= 2 &&
    items.length <= ALBUM_MAX &&
    items.every((it) => it.mediaType === 'image' || it.mediaType === 'video')

  const handlePreviewSend = useCallback(
    async (caption: string, opts: { sendOriginal: boolean }) => {
      if (sendingMediaRef.current || fileQueue.length === 0) return
      sendingMediaRef.current = true
      try {
        if (sendAlbum && canAlbum(fileQueue)) {
          await sendAlbum(
            fileQueue.map((it) => ({
              blob: it.file,
              segmentClass: it.mediaType,
              options: {
                label: it.file.name,
                mime: it.file.type,
                sendOriginal: opts.sendOriginal,
              },
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
          sendOriginal: opts.sendOriginal,
        })
        setFileQueue((prev) => prev.slice(1))
      } finally {
        sendingMediaRef.current = false
      }
    },
    [sendMedia, sendAlbum, fileQueue],
  )

  const handlePreviewCancel = useCallback(() => setFileQueue([]), [])
  const handleRemoveFromQueue = useCallback((index: number) => {
    setFileQueue((prev) => prev.filter((_, i) => i !== index))
  }, [])
  const handleReorderQueue = useCallback((from: number, to: number) => {
    setFileQueue((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])
  const handleAddMoreToQueue = useCallback((files: File[]) => {
    setFileQueue((prev) => {
      const room = ALBUM_HARD_CAP - prev.length
      if (room <= 0) {
        toastError(`Album already has ${ALBUM_HARD_CAP} items`, { title: 'Media' })
        return prev
      }
      const accepted = files.slice(0, room)
      if (files.length > room) {
        toastError(`${files.length - room} dropped (cap ${ALBUM_HARD_CAP})`, { title: 'Media' })
      }
      return [
        ...prev,
        ...accepted.map((file) => ({ file, mediaType: detectMediaType(file) })),
      ]
    })
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
        await sendText(messageText, replyTo?.id ?? null, { burn_duration_secs: makeBurnDuration(burnTimerSecs) })
      }
      onSubmitOrClear()
      setMessageText('')
      setReplyTo(null)
      setEditingMessage(null)
      if (activeChatId) clearDraft(activeChatId)
      if (inputRef.current) {
        inputRef.current.style.height = 'auto'
        inputRef.current.focus()
      }
    } finally {
      sendingTextRef.current = false
      setSendingText(false)
    }
  }

  // Edit existing message. Re-encrypts the new plaintext with the same
  // crypto context as the original send (fan-out for DIRECT, group key for
  // SECTOR, plaintext for PUBLIC) and PATCHes the server.
  async function submitEdit(messageId: string, newText: string) {
    if (!cryptoCtx) return
    try {
      const { patchMessage } = await import('@/lib/api/messages')

      let editBody: Parameters<typeof patchMessage>[1]

      if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
        // DIRECT/SELF edits require vault key access to re-encrypt fan-out slots.
        // This is handled server-side — send null content so the server knows it
        // is a fan-out message; the client re-fetches the decrypted plaintext.
        editBody = { content: null, iv: null }
      } else if (cryptoCtx.mode === 'SECTOR') {
        // Group: re-encrypt with the current group key
        const { encryptMessage } = await import('@/lib/crypto')
        const { ciphertext, iv } = await encryptMessage(cryptoCtx.groupKey, newText)
        editBody = { content: ciphertext, iv }
      } else {
        // PUBLIC: base64-encode plaintext
        editBody = {
          content: btoa(unescape(encodeURIComponent(newText))),
          iv: 'public',
        }
      }

      await patchMessage(messageId, editBody)

      // Optimistic update: update plaintext in store
      useChatStore.getState().updateMessagePlaintext(messageId, newText)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'EDIT_FAILED'
      toastError(msg, { title: 'EDIT' })
    }
  }

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


  const showSendOnMobile = messageText.trim().length > 0

  // Channel subscriber read-only bar
  if (disabled && cryptoCtx?.mode === 'PUBLIC') {
    return (
      <div className={`p13-composer chat-compose-shell sticky bottom-0 z-10 shrink-0 flex items-center justify-center gap-2 px-4 py-3 ${
        isMd3
          ? 'border-t border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)]'
          : 'border-t border-neon-cyan/10 bg-void'
      }`}>
        <span className={`text-[11px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-widest text-text-muted/50'}`}>
          {isMd3 ? 'View-only channel' : '[ CHANNEL — VIEW ONLY ]'}
        </span>
      </div>
    )
  }

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
          'var(--p13-composer-bottom-inset, max(0.5rem, env(safe-area-inset-bottom, 0px)))',
      }}
    >
      <UploadProgressList />
      {previewFile && (
        <MediaPreviewModal
          file={previewFile.file}
          mediaType={previewFile.mediaType}
          queue={fileQueue}
          onRemoveFromQueue={handleRemoveFromQueue}
          onReorder={handleReorderQueue}
          onAddMore={handleAddMoreToQueue}
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
        <div className="p13-record-bar p13-audio-card rounded-[var(--p13-radius-input)] px-2 py-2">
          <button type="button" onClick={() => void cancelRecording()}
            className="p13-media-action-btn p13-icon-btn p13-icon-btn--danger shrink-0"
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
            className="p13-media-action-btn p13-icon-btn p13-icon-btn--primary shrink-0"
            title={t('common.send')}>
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Normal input row */}
      <div className={`flex items-center gap-2 ${isRecordingUI && recordLocked ? 'hidden' : ''}`}>

        {/* Emoji button — left side, next to attach */}
        {!isRecordingUI ? (
          <div ref={composerPickerRef} className={`relative shrink-0 ${isMd3 ? 'order-3' : ''}`}>
            <button
              type="button"
              className="p13-icon-btn"
              disabled={disabled}
              onClick={() => {
                if (matchesDockViewport()) {
                  const store = useDockStore.getState()
                  if (store.slot === 'composer') {
                    store.close()
                  } else {
                    store.openComposer({
                      onEmoji: (emoji) => insertEmoji(emoji),
                      onStickerSend: async (json) => {
                        await sendSticker(json)
                      },
                      onGifPick: async (gif) => {
                        await sendGif(gif)
                      },
                    })
                  }
                  return
                }
                setComposerPickerOpen((o) => !o)
              }}
              title={t('composer.toggle')}
            >
              <Smile className="h-4 w-4" />
            </button>
            {composerPickerOpen ? (
              <div className="p13-emoji-popup p13-picker-panel w-[min(440px,92vw)] h-[min(520px,70vh)] overflow-hidden">
                <ComposerPickerPanel
                  layout="modal"
                  onEmoji={(emoji) => insertEmoji(emoji)}
                  onStickerSend={async (json) => {
                    await sendSticker(json)
                    setComposerPickerOpen(false)
                  }}
                  onGifPick={async (gif) => {
                    await sendGif(gif)
                  }}
                  onAfterStickerSend={() => setComposerPickerOpen(false)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Attach — always opens file picker directly */}
        <div className={`relative shrink-0 ${isMd3 ? 'order-1' : ''}`}>
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

        {/* Poll composer button */}
        {!isRecordingUI ? (
          <div className={`relative shrink-0 ${isMd3 ? 'order-1' : ''}`}>
            <button
              type="button"
              className="p13-icon-btn"
              disabled={disabled}
              onClick={() => { setPollQuestion(''); setPollOptions(['', '']); setPollMultiple(false); setPollAnon(false); setPollModalOpen(true) }}
              title="Create poll"
              aria-label="Create poll"
            >
              <BarChart2 className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        {/* Poll creation modal */}
        {pollModalOpen ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create poll"
            className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setPollModalOpen(false) }}
          >
            <div className="relative w-full max-w-sm rounded-[var(--p13-radius-msg)] border border-neon-cyan/30 bg-void p-4 shadow-lg">
              <button
                type="button"
                className="absolute right-2 top-2 p13-icon-btn"
                onClick={() => setPollModalOpen(false)}
                aria-label="Close"
              >
                <X className="h-3 w-3" />
              </button>
              <p className="mb-3 font-mono text-[11px] uppercase tracking-widest text-neon-cyan/60">CREATE POLL</p>

              {/* Question */}
              <input
                className="mb-2 w-full rounded-[var(--p13-radius-msg)] border border-neon-cyan/20 bg-void/60 px-2 py-1.5 font-[family-name:var(--p13-font-body)] text-[12px] outline-none focus:border-neon-cyan/50"
                placeholder="Question..."
                maxLength={300}
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
              />

              {/* Options */}
              <div className="mb-2 flex flex-col gap-1">
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="flex gap-1">
                    <input
                      className="flex-1 rounded-[var(--p13-radius-msg)] border border-neon-cyan/15 bg-void/50 px-2 py-1 font-[family-name:var(--p13-font-body)] text-[11px] outline-none focus:border-neon-cyan/40"
                      placeholder={`Option ${idx + 1}`}
                      maxLength={200}
                      value={opt}
                      onChange={(e) => {
                        const next = [...pollOptions]
                        next[idx] = e.target.value
                        setPollOptions(next)
                      }}
                    />
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        className="shrink-0 text-text-muted hover:text-danger"
                        onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== idx))}
                        aria-label="Remove option"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 10 && (
                  <button
                    type="button"
                    className="mt-0.5 text-left font-mono text-[9px] uppercase tracking-widest text-neon-cyan/50 hover:text-neon-cyan/80"
                    onClick={() => setPollOptions([...pollOptions, ''])}
                  >
                    + Add option
                  </button>
                )}
              </div>

              {/* Toggles */}
              <div className="mb-3 flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] text-text-muted">
                  <input
                    type="checkbox"
                    checked={pollMultiple}
                    onChange={(e) => setPollMultiple(e.target.checked)}
                    className="accent-neon-cyan"
                  />
                  Multiple choice
                </label>
                <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] text-text-muted">
                  <input
                    type="checkbox"
                    checked={pollAnon}
                    onChange={(e) => setPollAnon(e.target.checked)}
                    className="accent-neon-cyan"
                  />
                  Anonymous votes
                </label>
              </div>

              {/* Submit */}
              <button
                type="button"
                disabled={pollSending || !pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2 || !activeChatId}
                className="w-full rounded-[var(--p13-radius-msg)] border border-neon-cyan/40 bg-neon-cyan/10 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40"
                onClick={async () => {
                  if (!activeChatId) return
                  const opts = pollOptions.filter((o) => o.trim())
                  if (!pollQuestion.trim() || opts.length < 2) return
                  setPollSending(true)
                  try {
                    await createPoll({
                      chat_id: activeChatId,
                      question: pollQuestion.trim(),
                      options: opts,
                      allow_multiple: pollMultiple,
                      is_anonymous: pollAnon,
                    })
                    setPollModalOpen(false)
                  } catch {
                    // createPoll already throws a string error
                  } finally {
                    setPollSending(false)
                  }
                }}
              >
                {pollSending ? 'Sending...' : 'Send Poll'}
              </button>
            </div>
          </div>
        ) : null}

        {/* Burn timer picker */}
        {!isRecordingUI ? (
          <div ref={burnMenuRef} className={`relative shrink-0 ${isMd3 ? 'order-1' : ''}`}>
            <button
              type="button"
              className={`p13-icon-btn ${burnTimerSecs ? 'text-orange-400' : ''}`}
              disabled={disabled}
              onClick={() => setBurnMenuOpen((o) => !o)}
              title={t('chat.burnTimerLabel')}
            >
              <Flame className={`h-4 w-4 ${burnTimerSecs ? 'fill-orange-400/30 text-orange-400' : ''}`} />
              {burnTimerSecs ? (
                <span className="absolute -top-1 -right-1 rounded-full bg-orange-500 px-1 text-[9px] font-bold leading-tight text-white">
                  {formatBurnTimerShort(burnTimerSecs)}
                </span>
              ) : null}
            </button>
            {burnMenuOpen ? (
              <div className="absolute bottom-full mb-2 left-0 z-50 min-w-[160px] rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] shadow-xl">
                <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                  {t('chat.burnTimerLabel')}
                </div>
                {BURN_OPTIONS.map((opt) => (
                  <button
                    key={opt.labelKey}
                    type="button"
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:opacity-70 transition-opacity ${burnTimerSecs === opt.secs ? 'text-orange-400 font-semibold' : 'text-[color:var(--on-surface)]'}`}
                    onClick={() => { setBurnTimerSecs(opt.secs); setBurnMenuOpen(false) }}
                  >
                    {opt.secs ? <Flame className="h-3.5 w-3.5 shrink-0 text-orange-400" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                    {t(opt.labelKey as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Input field */}
        <div className={`relative flex-1 ${isMd3 ? 'order-2' : ''}`}>
          <FormatToolbar
            visible={formatToolbar.visible}
            position={{ top: formatToolbar.top, left: formatToolbar.left }}
            onFormat={applyFormat}
          />
          <div
            className={`p13-composer-input relative ${
              isRecordingUI ? 'ring-1 ring-danger/40' : ''
            }`}
          >
            <MentionsPopover
              open={mentionOpen}
              members={mentionMembers}
              query={mentionQuery}
              activeIndex={mentionActiveIdx}
              onSelect={handleMentionSelect}
              onClose={() => setMentionOpen(false)}
            />
            <textarea
              ref={inputRef}
              rows={1}
              className="flex-1 min-h-6 max-h-[120px] resize-none bg-transparent border-0 outline-none text-[color:var(--on-surface)] placeholder:text-[color:var(--text-muted)] disabled:cursor-not-allowed"
              style={{ fontSize: 'max(16px, 1em)' }}
              value={messageText}
              inputMode="text"
              enterKeyHint="send"
              onChange={(e) => {
                const next = e.target.value
                setMessageText(next)
                onDraftChanged(next)
                // Persist draft (debounced) — cleared on send
                if (activeChatId && !editingMessage) {
                  saveDraftDebounced(activeChatId, next)
                }
                // @mention trigger detection
                handleMentionCheck(next, e.target.selectionStart ?? next.length)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
              }}
              onSelect={handleTextareaSelect}
              onBlur={() => {
                // Delay hide so toolbar click can fire first
                setTimeout(() => {
                  setFormatToolbar((prev) => ({ ...prev, visible: false }))
                }, 150)
              }}
              onFocus={() => {
                // Scroll composer into view when keyboard opens on mobile
                setTimeout(() => {
                  inputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                }, 300)
              }}
              onKeyDown={(e) => {
                // @mention popover navigation
                if (mentionOpen) {
                  const filtered = mentionQuery
                    ? mentionMembers.filter(
                        (m) =>
                          m.username.toLowerCase().startsWith(mentionQuery.toLowerCase()) ||
                          (m.displayName?.toLowerCase().startsWith(mentionQuery.toLowerCase()) ?? false)
                      )
                    : mentionMembers.slice(0, 8)
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionActiveIdx((i) => (i + 1) % Math.max(filtered.length, 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionActiveIdx((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1))
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    const chosen = filtered[mentionActiveIdx]
                    if (chosen) {
                      e.preventDefault()
                      handleMentionSelect(chosen)
                      return
                    }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMentionOpen(false)
                    return
                  }
                }
                // Formatting hotkeys
                if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                  e.preventDefault()
                  applyFormat('**')
                  return
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                  e.preventDefault()
                  applyFormat('_')
                  return
                }
                if ((e.ctrlKey || e.metaKey) && e.key === '`') {
                  e.preventDefault()
                  applyFormat('`')
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (messageText.trim() && !disabled && !sendingTextRef.current) void onSubmit(e as unknown as React.FormEvent)
                }
                if (e.key === 'Escape') {
                  if (replyTo) {
                    setReplyTo(null)
                    return
                  }
                  if (composerPickerOpen) {
                    setComposerPickerOpen(false)
                    return
                  }
                  const store = useDockStore.getState()
                  if (store.slot === 'composer' || store.slot === 'emoji') {
                    store.close()
                  }
                }
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
          } ${showSendOnMobile ? 'hidden' : 'inline-flex'} ${isMd3 ? 'order-4' : ''}`}
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
          } md:inline-flex ${isMd3 ? 'order-5' : ''}`}
          onClick={(e) => void onSubmit(e as unknown as React.FormEvent)}
          aria-label={t('common.send')}
          title={t('common.send')}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}

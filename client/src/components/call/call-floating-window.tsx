'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, PhoneOff, Maximize2 } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'
import { useSpeaking, useVideoTrack } from '@/hooks/use-call-media'

/**
 * PROJECT 13 :: FLOATING_CALL_WINDOW (shared by the 1:1 and group mini-players)
 *
 * The old minimized call was a 40px chip in the bottom-right corner — easy to
 * lose under other UI ("сворачивается в невидное"). This is a proper Discord-
 * style floating window: remote video preview (or avatar), draggable anywhere,
 * position persisted, always clamped inside the viewport, with mute/expand/end
 * controls.
 */

const POS_KEY = 'p13_mini_call_pos'

function loadPos(): { x: number; y: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { x: number; y: number }
    if (typeof v.x !== 'number' || typeof v.y !== 'number') return null
    return v
  } catch {
    return null
  }
}

function clampPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4)),
    y: Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4)),
  }
}

export function FloatingCallWindow({
  stream,
  title,
  elapsedMs,
  micMuted,
  onExpand,
  onToggleMute,
  onEndCall,
}: {
  /** Remote stream to preview (video if present, speaking ring off its audio). */
  stream: MediaStream | null
  title: string
  elapsedMs: number
  micMuted: boolean
  onExpand: () => void
  onToggleMute: () => void
  onEndCall: () => void
}) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadPos())
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)
  const { active: hasVideo } = useVideoTrack(stream)
  const speaking = useSpeaking(stream, true)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (hasVideo && stream) {
      if (v.srcObject !== stream) v.srcObject = stream
      void v.play().catch(() => {})
    } else {
      v.srcObject = null
    }
  }, [stream, hasVideo])

  // Keep the window inside the viewport on resize.
  useEffect(() => {
    const onResize = () => {
      const el = rootRef.current
      if (!el) return
      setPos((prev) => {
        if (!prev) return prev
        return clampPos(prev.x, prev.y, el.offsetWidth, el.offsetHeight)
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Buttons handle their own clicks.
    if ((e.target as HTMLElement).closest('button')) return
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY
      if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true
      if (d.moved) {
        setPos(clampPos(d.baseX + dx, d.baseY + dy, el.offsetWidth, el.offsetHeight))
      }
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (d && !d.moved) {
        onExpand()
      } else {
        setPos((prev) => {
          if (prev) {
            try { window.localStorage.setItem(POS_KEY, JSON.stringify(prev)) } catch { /* quota */ }
          }
          return prev
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [onExpand])

  const mins = Math.floor(elapsedMs / 60000)
  const secs = Math.floor((elapsedMs % 60000) / 1000)
  const timer = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      className={`fixed z-[230] w-60 cursor-grab touch-none select-none overflow-hidden shadow-2xl backdrop-blur-xl active:cursor-grabbing md:w-72 ${
        isMd3
          ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface-container-high,var(--surface-elevated))]'
          : `border bg-void/95 ${speaking ? 'border-neon-cyan' : 'border-border-strong'}`
      }`}
      style={
        pos
          ? { left: `${pos.x}px`, top: `${pos.y}px` }
          : { right: '1rem', bottom: '6rem' }
      }
      role="dialog"
      aria-label={t('call.returnToCall')}
    >
      {/* Video / avatar area */}
      <div className="relative aspect-video w-full bg-void">
        {hasVideo ? (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-full border ${
                speaking ? 'border-neon-cyan bg-neon-cyan/10' : 'border-border-strong bg-void'
              }`}
            >
              <span className={`${isMd3 ? 'font-sans font-semibold text-[var(--primary)]' : 'font-mono text-neon-cyan'} text-xs uppercase`}>
                {title.slice(0, 2)}
              </span>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onExpand}
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center bg-void/70 text-text-primary/80 backdrop-blur-sm transition-colors hover:text-neon-cyan"
          title={t('call.returnToCall')}
          aria-label={t('call.returnToCall')}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Title + controls */}
      <div className={`flex items-center justify-between gap-2 px-2.5 py-2 ${isMd3 ? '' : 'border-t border-border-strong/60'}`}>
        <div className="min-w-0">
          <p className={`truncate text-[11px] text-text-primary ${isMd3 ? 'font-sans font-medium' : 'font-mono uppercase tracking-wider'}`}>
            {title}
          </p>
          <p className={`text-[9px] ${isMd3 ? 'text-[var(--on-surface-variant)]' : 'font-mono tracking-wider text-neon-cyan/70'}`}>
            {timer}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleMute}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              micMuted
                ? (isMd3 ? 'text-[var(--error)]' : 'bg-danger/20 text-neon-red')
                : 'text-text-muted hover:text-text-primary'
            }`}
            title={micMuted ? t('call.unmute') : t('call.mute')}
            aria-pressed={micMuted}
          >
            {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onEndCall}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              isMd3
                ? 'text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_15%,transparent)]'
                : 'text-neon-red hover:bg-neon-red/20'
            }`}
            title={t('call.endCall')}
            aria-label={t('call.endCall')}
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

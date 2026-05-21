'use client'

import { Phone } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  disabled: boolean
  peerReady: boolean
  /** Starts a call. The call begins audio-only; video/screen-share are opt-in
   *  via the in-call controls. */
  onCall: () => void
}

/**
 * Single "Call" affordance for the chat header. The user no longer picks
 * voice-vs-video up front — one button starts the call (audio-first).
 */
export function CallHeaderButtons({ disabled, peerReady, onCall }: Props) {
  const { t } = useTranslation()
  const isOffline = disabled || !peerReady
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  return (
    <div
      className={`flex items-center max-[1180px]:gap-0 ${
        isMd3
          ? 'gap-1 rounded-full bg-[color-mix(in_srgb,var(--surface-elevated)_80%,transparent)] p-1 max-[1180px]:p-0.5'
          : 'border border-border-strong bg-void font-mono shadow-[0_0_15px_rgba(0,0,0,0.5)]'
      }`}
    >
      {/* Node Status Indicator */}
      <div
        className={`hidden md:flex h-10 w-10 items-center justify-center max-[1180px]:hidden ${
          isMd3
            ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
            : 'border-r border-border-strong bg-void/50'
        }`}
      >
        <span className="relative flex h-2 w-2">
          {!isOffline && (
            <span className="absolute inline-flex h-full w-full animate-ping bg-neon-cyan opacity-75"></span>
          )}
          <span
            className={`relative inline-flex h-2 w-2 ${
              isOffline ? 'bg-elevated' : 'bg-neon-cyan shadow-[0_0_6px_rgba(0,255,255,0.9)]'
            }`}
          ></span>
        </span>
      </div>

      {/* Single Call button — starts an audio-first call */}
      <button
        type="button"
        disabled={isOffline}
        onClick={onCall}
        title={isOffline ? t('call.noConnection') : t('call.startCall')}
        aria-label={isOffline ? t('call.noConnection') : t('call.startCall')}
        className={`touch-manipulation relative flex h-10 min-w-[2.75rem] items-center justify-center gap-2 px-3 max-[1180px]:min-w-[2.25rem] max-[1180px]:px-2 transition-all ${
          isOffline
            ? `cursor-not-allowed ${isMd3 ? 'rounded-full text-text-muted/70' : 'text-text-muted/70'}`
            : isMd3
              ? 'rounded-full text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] active:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
              : 'text-neon-cyan hover:bg-neon-cyan/10 hover:text-text-primary active:bg-neon-cyan/20'
        }`}
      >
        <Phone
          className={`h-4 w-4 shrink-0 ${isOffline ? 'opacity-30' : ''}`}
          strokeWidth={isOffline ? 1 : 2}
          aria-hidden
        />
        <span className={`hidden text-[10px] sm:inline ${isMd3 ? 'sr-only' : 'uppercase tracking-[0.25em]'}`}>
          {isOffline ? t('call.noLink') : t('call.callShort')}
        </span>
      </button>
    </div>
  )
}

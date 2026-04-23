'use client'

import { Phone, Video } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'

type Props = {
  disabled: boolean
  peerReady: boolean
  onVoiceCall: () => void
  onVideoCall: () => void
}

export function CallHeaderButtons({
  disabled,
  peerReady,
  onVoiceCall,
  onVideoCall,
}: Props) {
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

      {/* Voice Call */}
      <button
        type="button"
        disabled={isOffline}
        onClick={onVoiceCall}
        title={isOffline ? 'No connection' : 'Voice call'}
        className={`touch-manipulation relative flex h-10 min-w-[2.75rem] items-center justify-center gap-2 px-3 max-[1180px]:min-w-[2.25rem] max-[1180px]:px-2 transition-all ${
          isOffline
            ? `cursor-not-allowed ${isMd3 ? 'rounded-full text-text-muted/70' : 'border-r border-border-strong text-text-muted/70'}`
            : isMd3
              ? 'rounded-full text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] active:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
              : 'border-r border-neon-cyan/50 text-neon-cyan hover:border-neon-cyan hover:bg-neon-cyan/10 hover:text-text-primary active:bg-neon-cyan/20'
        }`}
      >
        <Phone
          className={`h-4 w-4 shrink-0 ${isOffline ? 'opacity-30' : ''}`}
          strokeWidth={isOffline ? 1 : 2}
          aria-hidden
        />
        <span className={`hidden text-[10px] sm:inline ${isMd3 ? 'sr-only' : 'uppercase tracking-[0.25em]'}`}>
          {isOffline ? 'NO_LINK' : 'AUDIO'}
        </span>
      </button>

      {/* Video Call */}
      <button
        type="button"
        disabled={isOffline}
        onClick={onVideoCall}
        title={isOffline ? 'No connection' : 'Video call'}
        className={`touch-manipulation relative flex h-10 min-w-[2.75rem] items-center justify-center gap-2 px-3 max-[1180px]:min-w-[2.25rem] max-[1180px]:px-2 transition-all ${
          isOffline
            ? `cursor-not-allowed ${isMd3 ? 'rounded-full text-text-muted/70' : 'border border-border-strong text-text-muted/70'}`
            : isMd3
              ? 'rounded-full text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] active:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
              : 'border border-neon-red/50 text-neon-red hover:border-neon-red hover:bg-neon-red/10 hover:text-text-primary active:bg-neon-red/20'
        }`}
      >
        <Video
          className={`h-4 w-4 shrink-0 ${isOffline ? 'opacity-30' : ''}`}
          strokeWidth={isOffline ? 1 : 2}
          aria-hidden
        />
        <span className={`hidden text-[10px] sm:inline ${isMd3 ? 'sr-only' : 'uppercase tracking-[0.25em]'}`}>
          {isOffline ? 'NO_LINK' : 'VIDEO'}
        </span>
      </button>
    </div>
  )
}

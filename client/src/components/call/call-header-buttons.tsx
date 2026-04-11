'use client'

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
  const off = disabled || !peerReady

  return (
    <div className="flex flex-wrap items-center gap-2 font-mono">
      <button
        type="button"
        disabled={off}
        onClick={onVoiceCall}
        className="touch-manipulation flex min-h-11 min-w-[44px] shrink-0 items-center justify-center rounded-none border border-neon-cyan bg-black px-3 py-2 text-[10px] uppercase tracking-[0.25em] text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40 md:min-h-9 md:px-2 md:py-1.5"
      >
        [ CALL :: VOICE ]
      </button>
      <button
        type="button"
        disabled={off}
        onClick={onVideoCall}
        className="touch-manipulation flex min-h-11 min-w-[44px] shrink-0 items-center justify-center rounded-none border border-neon-red bg-black px-3 py-2 text-[10px] uppercase tracking-[0.25em] text-neon-red hover:bg-neon-red/10 disabled:opacity-40 md:min-h-9 md:px-2 md:py-1.5"
      >
        [ CALL :: VIDEO ]
      </button>
    </div>
  )
}

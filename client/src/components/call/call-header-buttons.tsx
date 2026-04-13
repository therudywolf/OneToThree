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
  const isOffline = disabled || !peerReady

  return (
    <div className="flex items-center border border-neutral-900 bg-black font-mono shadow-[0_0_15px_rgba(0,0,0,0.5)]">
      {/* Node Status Indicator */}
      <div className="hidden sm:flex h-9 w-10 items-center justify-center border-r border-neutral-900 bg-zinc-950/50">
        <span className="relative flex h-1.5 w-1.5">
          {!isOffline && (
            <span className="absolute inline-flex h-full w-full animate-ping bg-neon-cyan opacity-75"></span>
          )}
          <span
            className={`relative inline-flex h-1.5 w-1.5 ${
              isOffline ? 'bg-neutral-700' : 'bg-neon-cyan shadow-[0_0_5px_rgba(0,255,255,0.8)]'
            }`}
          ></span>
        </span>
      </div>

      {/* Audio Link */}
      <button
        type="button"
        disabled={isOffline}
        onClick={onVoiceCall}
        className={`touch-manipulation relative flex h-9 items-center justify-center border-r border-neutral-900 px-4 transition-all ${
          isOffline
            ? 'cursor-not-allowed text-neutral-600'
            : 'text-neon-cyan hover:bg-neon-cyan/10 hover:text-white active:bg-neon-cyan/20'
        }`}
      >
        <span className="text-[10px] uppercase tracking-[0.25em]">
          {isOffline ? 'NO_LINK' : 'SYS.AUDIO'}
        </span>
      </button>

      {/* Optics Link */}
      <button
        type="button"
        disabled={isOffline}
        onClick={onVideoCall}
        className={`touch-manipulation relative flex h-9 items-center justify-center px-4 transition-all ${
          isOffline
            ? 'cursor-not-allowed text-neutral-600'
            : 'text-neon-red hover:bg-neon-red/10 hover:text-white active:bg-neon-red/20'
        }`}
      >
        <span className="text-[10px] uppercase tracking-[0.25em]">
          {isOffline ? 'NO_LINK' : 'SYS.OPTICS'}
        </span>
      </button>
    </div>
  )
}
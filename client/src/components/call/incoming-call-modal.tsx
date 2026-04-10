'use client'

import { useCallStore } from '@/store/callStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = {
  onAccept: () => void
  onReject: () => void
}

export function IncomingCallModal({ onAccept, onReject }: Props) {
  const incoming = useCallStore((s) => s.incomingCall)

  if (!incoming) return null

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/95 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      <div className="terminal-panel w-full max-w-md space-y-6 border border-red-500/50 shadow-[0_0_10px_rgba(255,0,0,0.5)]">
        <header className="border-b border-neon-cyan/40 pb-3">
          <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ INCOMING_CALL ]
          </p>
          <p className="mt-2 font-mono text-sm text-neon-red">
            PEER :: {incoming.peerId}
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">
            MODE :: {incoming.isVideo ? 'VIDEO' : 'AUDIO'}
          </p>
        </header>
        <div className="flex flex-wrap gap-3">
          <TerminalGlitchButton type="button" onClick={onAccept}>
            [ ACCEPT ]
          </TerminalGlitchButton>
          <button
            type="button"
            onClick={onReject}
            className="rounded-none border border-neon-red bg-black px-6 py-2 font-mono text-xs uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
          >
            [ REJECT ]
          </button>
        </div>
      </div>
    </div>
  )
}

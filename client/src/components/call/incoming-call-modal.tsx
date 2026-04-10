'use client'

import { useEffect } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { useCallStore } from '@/store/callStore'

type Props = {
  onAccept: () => void
  onReject: () => void
}

export function IncomingCallModal({ onAccept, onReject }: Props) {
  const incoming = useCallStore((s) => s.incomingCall)

  useEffect(() => {
    if (!incoming) return
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 440
    gain.gain.value = 0.15
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()

    const id = setInterval(() => {
      const t = ctx.currentTime
      gain.gain.setValueAtTime(0.15, t)
      gain.gain.linearRampToValueAtTime(0, t + 0.4)
      gain.gain.setValueAtTime(0, t + 0.6)
      gain.gain.linearRampToValueAtTime(0.15, t + 0.7)
    }, 1400)

    return () => {
      clearInterval(id)
      osc.stop()
      ctx.close().catch(() => {})
    }
  }, [incoming])

  if (!incoming) return null

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/95 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      <div className="terminal-panel w-full max-w-md space-y-6 border border-red-500/50 shadow-[0_0_20px_rgba(255,0,0,0.5)]">
        <header className="border-b border-neon-cyan/40 pb-3">
          <p className="animate-pulse text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ INCOMING_CALL ]
          </p>
          <p className="mt-2 font-mono text-sm text-neon-red">
            PEER :: {incoming.peerId.slice(0, 12)}…
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">
            MODE :: {incoming.isVideo ? 'VIDEO' : 'AUDIO'}
          </p>
        </header>
        <div className="flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={onAccept}
            className="animate-neon-pulse rounded-none border-2 border-neon-cyan bg-black p-4 text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            aria-label="Accept call"
          >
            <Phone className="h-6 w-6" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={onReject}
            className="rounded-none border-2 border-neon-red bg-black p-4 text-neon-red transition-colors hover:bg-neon-red/10"
            aria-label="Reject call"
          >
            <PhoneOff className="h-6 w-6" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  )
}

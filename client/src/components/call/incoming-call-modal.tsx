'use client'

import { useEffect } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { startIncomingRingtone } from '@/lib/call-ringtones'
import { useCallStore } from '@/store/callStore'
import { PortalRoot } from '@/components/portal-root'

type Props = {
  onAccept: () => void
  onReject: () => void
}

export function IncomingCallModal({ onAccept, onReject }: Props) {
  const incoming = useCallStore((s) => s.incomingCall)

  useEffect(() => {
    if (!incoming) return
    const stop = startIncomingRingtone()
    return () => {
      stop()
    }
  }, [incoming])

  if (!incoming) return null

  return (
    <PortalRoot>
      <div
        className="fixed inset-0 z-[250] flex items-center justify-center bg-black/90 px-4 font-mono backdrop-blur-md"
        role="dialog"
        aria-modal="true"
        aria-label="Incoming connection"
      >
        {/* TERMINAL MODAL */}
        <div className="relative w-full max-w-sm border border-neon-red bg-black p-6 shadow-[0_0_40px_rgba(255,0,0,0.15)]">
          {/* ACCENT BAR */}
          <div className="absolute left-0 top-0 h-1 w-full animate-pulse bg-neon-red" />

          <header className="border-b border-neutral-900 pb-4">
            <div className="flex items-center gap-2">
              <span className="block h-2 w-2 animate-ping bg-neon-red" />
              <p className="text-[10px] uppercase tracking-[0.4em] text-neon-red">
                SYS.ALERT // INBOUND_LINK
              </p>
            </div>
            
            <div className="mt-5 space-y-1">
              <p className="text-[9px] uppercase tracking-widest text-neutral-600">
                ORIGIN_NODE
              </p>
              <p className="text-sm text-neutral-200">
                {incoming.peerId.slice(0, 12)}…
              </p>
            </div>

            <div className="mt-3 space-y-1">
              <p className="text-[9px] uppercase tracking-widest text-neutral-600">
                PAYLOAD_TYPE
              </p>
              <p className="text-[10px] tracking-widest text-neon-cyan">
                {incoming.isVideo ? '[ AUDIO + OPTICS ]' : '[ AUDIO_ONLY ]'}
              </p>
            </div>
          </header>

          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onAccept}
              className="group relative flex h-11 flex-1 items-center justify-center border border-neon-cyan bg-black text-neon-cyan transition-all hover:bg-neon-cyan/10 hover:shadow-[0_0_15px_rgba(0,255,255,0.2)]"
              aria-label="Accept link"
            >
              <span className="absolute left-3 opacity-50 transition-opacity group-hover:opacity-100">
                <Phone className="h-4 w-4" />
              </span>
              <span className="pl-4 text-[10px] uppercase tracking-[0.2em]">
                ACCEPT
              </span>
            </button>
            
            <button
              type="button"
              onClick={onReject}
              className="group relative flex h-11 flex-1 items-center justify-center border border-neon-red bg-black text-neon-red transition-all hover:bg-neon-red/10 hover:shadow-[0_0_15px_rgba(255,0,0,0.2)]"
              aria-label="Sever link"
            >
              <span className="absolute right-3 opacity-50 transition-opacity group-hover:opacity-100">
                <PhoneOff className="h-4 w-4" />
              </span>
              <span className="pr-4 text-[10px] uppercase tracking-[0.2em]">
                SEVER
              </span>
            </button>
          </div>
        </div>
      </div>
    </PortalRoot>
  )
}
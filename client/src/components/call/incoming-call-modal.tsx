'use client'

import { useEffect } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { startIncomingRingtone } from '@/lib/call-ringtones'
import { useCallStore } from '@/store/callStore'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'
import { PortalRoot } from '@/components/portal-root'
import { useFocusTrap } from '@/hooks/use-focus-trap'

type Props = {
  onAccept: () => void
  onReject: () => void
}

export function IncomingCallModal({ onAccept, onReject }: Props) {
  const incoming = useCallStore((s) => s.incomingCall)
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const { t } = useTranslation()
  const trapRef = useFocusTrap<HTMLDivElement>(!!incoming, onReject)

  useEffect(() => {
    if (!incoming) return
    const stop = startIncomingRingtone()
    return () => {
      stop()
    }
  }, [incoming])

  if (!incoming) return null

  if (isMd3) {
    return (
      <PortalRoot>
        <div
          ref={trapRef}
          className="fixed inset-0 z-[250] flex items-end justify-center bg-[color-mix(in_srgb,var(--void)_50%,transparent)] px-4 backdrop-blur-md sm:items-center"
          style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 2rem))' }}
          role="dialog"
          aria-modal="true"
          aria-label={t('call.incomingCall')}
        >
          <div className="w-full max-w-sm rounded-[28px] bg-[var(--surface-container-high)] p-6 shadow-[var(--md3-elevation-3)]">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--error-container)]">
                <Phone className="h-5 w-5 text-[var(--on-error-container)]" />
              </span>
              <div>
                <p className="text-sm font-medium text-[var(--on-surface)]">{t('call.incomingCall')}</p>
                <p className="text-xs text-[var(--on-surface-variant)]">{incoming.peerUsername ?? incoming.peerId.slice(0, 12) + '…'}</p>
              </div>
            </div>
            <p className="mb-6 text-xs text-[var(--on-surface-variant)]">
              {incoming.isVideo ? t('call.typeVideo') : t('call.typeAudio')}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onAccept}
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--primary)] py-3 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90"
                aria-label={t('call.accept')}
              >
                <Phone className="h-4 w-4" />
                {t('call.accept')}
              </button>
              <button
                type="button"
                onClick={onReject}
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--error)] py-3 text-sm font-medium text-[var(--on-error)] transition-opacity hover:opacity-90"
                aria-label={t('call.decline')}
              >
                <PhoneOff className="h-4 w-4" />
                {t('call.decline')}
              </button>
            </div>
          </div>
        </div>
      </PortalRoot>
    )
  }

  return (
    <PortalRoot>
      <div
        ref={trapRef}
        className={`fixed inset-0 z-[250] flex items-center justify-center px-4 backdrop-blur-md ${isRetro ? 'p13-classic-overlay' : 'bg-void/90 font-mono'}`}
        role="dialog"
        aria-modal="true"
        aria-label="Incoming connection"
      >
        {/* TERMINAL MODAL */}
        <div className={`relative w-full max-w-sm p-6 ${isRetro ? 'p13-classic-window' : 'border border-neon-red bg-void shadow-[0_0_40px_rgba(255,0,0,0.15)]'}`}>
          {/* ACCENT BAR */}
          <div className={`absolute left-0 top-0 h-1 w-full ${isRetro ? 'p13-classic-accent-fill' : 'animate-pulse bg-neon-red'}`} />

          <header className="border-b border-border-strong pb-4">
            <div className="flex items-center gap-2">
              <span className={`block h-2 w-2 ${isRetro ? 'p13-classic-accent-fill' : 'animate-ping bg-neon-red'}`} />
              <p className={`text-[10px] ${isRetro ? 'p13-classic-copy' : 'uppercase tracking-[0.4em] text-neon-red'}`}>
                SYS.ALERT // INBOUND_LINK
              </p>
            </div>

            <div className="mt-5 space-y-1">
              <p className="text-[9px] uppercase tracking-widest text-text-muted/70">
                ORIGIN_NODE
              </p>
              <p className="text-sm text-text-primary">
                {incoming.peerUsername ?? incoming.peerId.slice(0, 12) + '…'}
              </p>
            </div>

            <div className="mt-3 space-y-1">
              <p className="text-[9px] uppercase tracking-widest text-text-muted/70">
                PAYLOAD_TYPE
              </p>
              <p className={`text-[10px] ${isRetro ? 'p13-classic-copy-panel' : 'tracking-widest text-neon-cyan'}`}>
                {incoming.isVideo ? '[ AUDIO + OPTICS ]' : '[ AUDIO_ONLY ]'}
              </p>
            </div>
          </header>

          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onAccept}
              className={`group relative flex h-11 flex-1 items-center justify-center border transition-all ${
                isRetro
                  ? 'p13-classic-button'
                  : 'border-neon-cyan bg-void text-neon-cyan hover:bg-neon-cyan/10 hover:shadow-[0_0_15px_rgba(0,255,255,0.2)]'
              }`}
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
              className={`group relative flex h-11 flex-1 items-center justify-center border transition-all ${
                isRetro
                  ? 'p13-classic-button p13-classic-button--danger'
                  : 'border-neon-red bg-void text-neon-red hover:bg-neon-red/10 hover:shadow-[0_0_15px_rgba(255,0,0,0.2)]'
              }`}
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

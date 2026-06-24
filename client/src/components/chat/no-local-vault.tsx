'use client'

import { LogoutButton } from '@/components/logout-button'
import { useTranslation } from '@/hooks/use-translation'

/**
 * NoLocalVault — shown on a device that doesn't yet hold the user's key.
 * This is a normal, recoverable state (a fresh device), so the tone here is
 * calm and reassuring — not an emergency.
 */

export function NoLocalVault() {
  const { t } = useTranslation()

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-void px-4 font-mono selection:bg-neon-cyan selection:text-void">

      {/* BACKGROUND_FX */}
      <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.03] bg-[url('/noise.svg')]" />

      <div className="relative z-10 w-full max-w-md border border-neon-cyan/40 bg-void p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">

        {/* TOP_ACCENT */}
        <div className="absolute top-0 left-0 h-1 w-full bg-neon-cyan opacity-50 shadow-[0_0_15px_rgba(0,255,255,0.25)]" />

        <header className="mb-6 flex items-center gap-3 border-b border-neon-cyan/30 pb-4">
          <span className="h-2 w-2 rounded-full bg-neon-cyan" />
          <p className="text-sm tracking-wide text-text-primary">
            {t('noLocalVault.title')}
          </p>
        </header>

        <div className="space-y-6">
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-text-muted">
              {t('noLocalVault.body')}
            </p>
            <p className="text-xs leading-relaxed text-neon-cyan/80">
              {t('noLocalVault.reassure')}
            </p>
          </div>

          <div className="space-y-4">
            <div className="border-l border-neon-cyan/40 pl-4 py-1">
              <p className="text-[11px] text-text-primary">{t('noLocalVault.optionLinkTitle')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                {t('noLocalVault.optionLink')}
              </p>
            </div>

            <div className="border-l border-neon-cyan/40 pl-4 py-1">
              <p className="text-[11px] text-text-primary">{t('noLocalVault.optionRecoveryTitle')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                {t('noLocalVault.optionRecovery')}
              </p>
            </div>
          </div>

          <div className="pt-2">
            <LogoutButton />
          </div>
        </div>
      </div>
    </main>
  )
}

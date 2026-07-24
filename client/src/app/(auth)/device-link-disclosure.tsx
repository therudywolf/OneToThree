'use client'

import { useState } from 'react'
import { LoginQrDevicePanel } from '@/components/login-qr-device-panel'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Linking another device, as a SECONDARY affordance.
 *
 * It used to be a co-equal always-open panel sitting next to the password form,
 * with its own three-step sub-flow ("show/scan → compare codes → receive")
 * visible before you had done anything — which is a large part of why the entry
 * screen felt like a control room. It is still one click away, and it opens
 * expanded by default on phones, where it genuinely is the recommended route.
 */
export function DeviceLinkDisclosure() {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const [open, setOpen] = useState(false)

  return (
    <div className="w-full">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`w-full py-3 text-[10px] transition-colors ${
            isMd3
              ? 'rounded-full border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]'
              : 'border border-border-strong text-text-muted hover:text-neon-cyan hover:border-neon-cyan/40'
          }`}
        >
          {t('login.deviceLinkOpen')}
        </button>
      )}

      {open && (
        <div
          className={`p-5 ${
            isMd3
              ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-2)]'
              : 'border border-border-strong bg-void/50'
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <p className={`text-[10px] ${isMd3 ? 'font-medium text-[var(--on-surface)]' : 'uppercase tracking-[0.25em] text-neon-cyan'}`}>
              {t('login.deviceLinkTitle')}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[9px] text-text-muted/70 hover:text-neon-cyan"
            >
              {t('common.close')}
            </button>
          </div>
          <LoginQrDevicePanel embedded />
        </div>
      )}
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { setNotificationMode, type NotificationMode } from '@/lib/push-subscription'
import { explainSettingsError } from '@/lib/settings-errors'
import { useFocusTrap } from '@/hooks/use-focus-trap'

type Props = {
  open: boolean
  onDone: () => void
}

export function NotificationModeOnboarding({ open, onDone }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // D27 — focus trap + body-scroll-lock + focus restore. No ESC dismiss: the
  // user must explicitly pick a notification mode (there is no cancel path).
  const trapRef = useFocusTrap<HTMLDivElement>(open)

  if (!open) return null

  async function handleSelect(mode: NotificationMode) {
    setBusy(true)
    setError(null)
    try {
      await setNotificationMode(mode)
      onDone()
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="notif-mode-onboarding-title"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[color-mix(in_srgb,var(--void)_65%,transparent)] p-4"
    >
      <div className="w-full max-w-xl border border-border-strong bg-surface p-5">
        <h3 id="notif-mode-onboarding-title" className="text-sm font-semibold text-text-primary">{t('settings.notificationModeTitle')}</h3>
        <p className="mt-2 text-xs text-text-muted">{t('settings.notificationModeFirstRunHint')}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSelect('direct')}
            className="border border-neon-cyan/40 bg-void p-3 text-left transition hover:border-neon-cyan disabled:opacity-50"
          >
            <div className="text-xs font-semibold text-neon-cyan">{t('settings.notificationModeDirect')}</div>
            <div className="mt-1 text-[11px] text-text-muted">{t('settings.notificationModeDirectHint')}</div>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSelect('fcm')}
            className="border border-neon-red/40 bg-void p-3 text-left transition hover:border-neon-red disabled:opacity-50"
          >
            <div className="text-xs font-semibold text-neon-red">{t('settings.notificationModeFcm')}</div>
            <div className="mt-1 text-[11px] text-text-muted">{t('settings.notificationModeFcmHint')}</div>
          </button>
        </div>

        {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  )
}

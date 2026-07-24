'use client'

import { useEffect, useState } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'
import { isBackupPending } from '@/lib/backup-reminder'

/**
 * Keeps asking until the account can actually be recovered.
 *
 * The post-registration prompt is skippable by design — but skipping it used to
 * leave no trace at all, so the single warning the product gives about permanent
 * account loss could be dismissed forever with one Esc. Server-side vault
 * restore does not exist (those endpoints return 410), so "skipped" genuinely
 * means "one lost browser away from losing everything".
 *
 * This is a nag, not a gate: it can be hidden for the current session, but it
 * comes back on the next launch and only disappears for good once the key file
 * is saved or the recovery phrase is enrolled.
 */
export function BackupReminderBanner({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const userId = useSessionStore((s) => s.userId)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [hiddenForNow, setHiddenForNow] = useState(false)

  useEffect(() => {
    setPending(isBackupPending(userId))
    // Re-check when the tab regains focus: the user may have just completed the
    // backup in Settings in this same session.
    const recheck = () => setPending(isBackupPending(userId))
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [userId])

  if (!pending || hiddenForNow) return null

  return (
    <div
      role="status"
      className={`mx-3 mb-2 flex items-start gap-3 px-4 py-3 text-[11px] ${
        isMd3
          ? 'rounded-2xl border border-[color-mix(in_srgb,var(--neon-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--neon-red)_10%,transparent)] text-[var(--on-surface)]'
          : 'border border-neon-red/50 bg-danger/10 text-text-primary'
      }`}
    >
      <span aria-hidden className="mt-[1px]">🔑</span>
      <div className="flex-1">
        <p className="font-medium">{t('backupReminder.title')}</p>
        <p className="mt-1 leading-relaxed text-text-muted">{t('backupReminder.body')}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className={
                isMd3
                  ? 'rounded-full bg-[var(--neon-red)] px-3 py-1 text-[11px] font-medium text-[var(--surface)]'
                  : 'border border-neon-red px-3 py-1 text-[10px] uppercase tracking-widest text-neon-red'
              }
            >
              {t('backupReminder.action')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setHiddenForNow(true)}
            className="text-[10px] text-text-muted/70 underline-offset-2 hover:underline"
          >
            {t('backupReminder.later')}
          </button>
        </div>
      </div>
    </div>
  )
}

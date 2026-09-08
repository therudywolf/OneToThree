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
 *
 * On a phone it is ONE line — title, action, dismiss. The three-line version
 * cost ~110px above the message list on a 667px screen, every launch, to say
 * something the user can act on in one tap. The full explanation stays at
 * `sm` and up, where the room is free.
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
      className={`mx-3 mb-2 flex items-center gap-2 px-3 py-2 text-[11px] sm:items-start sm:gap-3 sm:px-4 sm:py-3 ${
        isMd3
          ? 'rounded-2xl border border-[color-mix(in_srgb,var(--neon-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--neon-red)_10%,transparent)] text-[var(--on-surface)]'
          : 'border border-neon-red/50 bg-danger/10 text-text-primary'
      }`}
    >
      <span aria-hidden className="shrink-0 sm:mt-[1px]">🔑</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:block">
        <p className="min-w-0 flex-1 truncate font-medium sm:overflow-visible sm:whitespace-normal">
          {t('backupReminder.title')}
        </p>
        <p className="mt-1 hidden leading-relaxed text-text-muted sm:block">{t('backupReminder.body')}</p>
        <div className="flex shrink-0 items-center gap-1 sm:mt-2 sm:flex-wrap sm:gap-3">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className={`min-h-[36px] shrink-0 ${
                isMd3
                  ? 'rounded-full bg-[var(--neon-red)] px-3 py-1 text-[11px] font-medium text-[var(--surface)]'
                  : 'border border-neon-red px-3 py-1 text-[10px] uppercase tracking-widest text-neon-red'
              }`}
            >
              {t('backupReminder.action')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setHiddenForNow(true)}
            className="min-h-[36px] shrink-0 px-2 text-[10px] text-text-muted/70 underline-offset-2 hover:underline"
          >
            {t('backupReminder.later')}
          </button>
        </div>
      </div>
    </div>
  )
}

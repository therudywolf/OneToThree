'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { useTranslation } from '@/hooks/use-translation'
import { readVaultBlob } from '@/lib/vault'
import { useThemeStore } from '@/store/themeStore'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import {
  prepareRecoveryEnrollment,
  commitRecoveryEnrollment,
  type RecoveryEnrollment,
} from '@/lib/recovery/enroll-recovery'

/**
 * After-registration "secure your account" flow. Two steps, both bilingual and
 * shell-aware (md3 / retro / terminal):
 *   1. backup   — download the encrypted account-backup file.
 *   2. recovery — set up the 24-word recovery phrase (the fallback if the
 *      password is ever forgotten). Needs the vault password from registration;
 *      if it isn't available the recovery step is skipped gracefully.
 * Called from login-form.tsx after a successful GENESIS. `onDismiss` finishes.
 */
export function PostRegisterVaultPrompt({
  onDismiss,
  vaultPassword,
}: {
  onDismiss: () => void
  vaultPassword?: string
}) {
  const { user } = useAuth()
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const trapRef = useFocusTrap<HTMLDivElement>(true, onDismiss)

  const userId = user?.id
  const canRecovery = Boolean(vaultPassword && userId)

  const [step, setStep] = useState<'backup' | 'recovery'>('backup')

  // ── Step 1: backup file ────────────────────────────────────────────────────
  const [exportState, setExportState] = useState<'idle' | 'done' | 'error'>('idle')
  const [savedConfirmed, setSavedConfirmed] = useState(false)

  function exportVault() {
    if (!userId) {
      setExportState('error')
      return
    }
    const blob = readVaultBlob(userId)
    if (!blob) {
      setExportState('error')
      return
    }
    const payload = JSON.stringify(
      { userId, username: user?.username ?? null, vault: blob, exported_at: new Date().toISOString() },
      null,
      2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `13vault-${userId.slice(0, 8)}.key`
    a.click()
    URL.revokeObjectURL(url)
    setExportState('done')
    setSavedConfirmed(true)
  }

  // Backup "continue" → go to the recovery step (or finish if recovery can't run).
  function afterBackup() {
    if (canRecovery) setStep('recovery')
    else onDismiss()
  }

  // ── Step 2: recovery phrase ────────────────────────────────────────────────
  const [enrollment, setEnrollment] = useState<RecoveryEnrollment | null>(null)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [phraseSaved, setPhraseSaved] = useState(false)
  const [phraseCopied, setPhraseCopied] = useState(false)

  // Generate the phrase as soon as the recovery step opens (Argon2 is light here).
  useEffect(() => {
    if (step !== 'recovery' || enrollment || recoveryBusy || !canRecovery || !userId || !vaultPassword) return
    let cancelled = false
    setRecoveryBusy(true)
    setRecoveryError(null)
    prepareRecoveryEnrollment(userId, vaultPassword)
      .then((e) => { if (!cancelled) setEnrollment(e) })
      .catch(() => { if (!cancelled) setRecoveryError(t('postRegister.recoveryError')) })
      .finally(() => { if (!cancelled) setRecoveryBusy(false) })
    return () => { cancelled = true }
  }, [step, enrollment, recoveryBusy, canRecovery, userId, vaultPassword, t])

  function downloadPhrase() {
    if (!enrollment || !userId) return
    const file = new Blob([enrollment.mnemonic + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `13recovery-${userId.slice(0, 8)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setPhraseSaved(true)
  }

  async function copyPhrase() {
    if (!enrollment) return
    try {
      await navigator.clipboard.writeText(enrollment.mnemonic)
      setPhraseCopied(true)
      setPhraseSaved(true)
      setTimeout(() => setPhraseCopied(false), 2000)
    } catch {
      /* clipboard blocked — the user can still write the words down */
    }
  }

  async function enableRecoveryAndFinish() {
    if (!enrollment) return
    setRecoveryBusy(true)
    setRecoveryError(null)
    try {
      await commitRecoveryEnrollment(enrollment, false)
      onDismiss()
    } catch {
      setRecoveryError(t('postRegister.recoveryError'))
      setRecoveryBusy(false)
    }
  }

  const overlayClass = isMd3
    ? 'bg-[color-mix(in_srgb,var(--void)_65%,transparent)] backdrop-blur-sm'
    : isRetro
      ? 'p13-classic-overlay'
      : 'bg-[color-mix(in_srgb,var(--void)_85%,transparent)]'

  const cardClass = `w-full max-w-md space-y-4 p-8 ${
    isMd3
      ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
      : isRetro
        ? 'p13-classic-window'
        : 'border border-neon-cyan/50 bg-void font-mono'
  }`
  const titleClass = `text-sm ${isMd3 ? 'text-[var(--on-surface)] tracking-normal' : isRetro ? 'p13-classic-copy' : 'text-neon-cyan'}`
  const primaryBtn = `w-full border px-3 py-3 text-xs transition-colors ${
    isRetro ? 'p13-classic-button' : 'border-neon-cyan bg-neon-cyan/5 font-mono tracking-wider text-neon-cyan hover:bg-neon-cyan/10'
  }`
  const mutedBtn = `w-full border px-3 py-2 text-xs ${
    isRetro ? 'p13-classic-button p13-classic-button--muted' : 'border-border-strong bg-transparent font-mono tracking-wider text-text-muted/70 hover:text-text-muted'
  }`

  // Two-line step indicator so the user knows there's a second step.
  const stepDots = canRecovery ? (
    <div className="mb-1 flex items-center justify-center gap-1.5" aria-hidden>
      {(['backup', 'recovery'] as const).map((s) => (
        <span
          key={s}
          className={`h-1.5 w-6 rounded-full transition-colors ${
            s === step ? 'bg-[var(--neon-cyan)]' : 'bg-[color-mix(in_srgb,var(--on-surface)_18%,transparent)]'
          }`}
        />
      ))}
    </div>
  ) : null

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={step === 'backup' ? t('postRegister.title') : t('postRegister.recoveryTitle')}
      className={`fixed inset-0 z-[120] flex items-center justify-center px-6 py-8 ${overlayClass}`}
    >
      {step === 'backup' ? (
        <div className={cardClass}>
          {stepDots}
          <div className={titleClass}>{t('postRegister.title')}</div>
          <p className="text-sm leading-relaxed text-text-muted">{t('postRegister.body')}</p>
          <p className="text-xs leading-relaxed text-text-muted">{t('postRegister.encryptedNote')}</p>
          <p className={`text-xs leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted/80'}`}>
            {t('postRegister.saveHint')}
          </p>
          {exportState === 'done' && (
            <div className="border border-neon-cyan/40 bg-neon-cyan/10 p-3 text-xs leading-relaxed text-neon-cyan">
              {t('postRegister.downloaded')}
            </div>
          )}
          {exportState === 'error' && (
            <div className="border border-neon-red/50 bg-neon-red/10 p-3 text-xs leading-relaxed text-neon-red">
              {t('postRegister.error')}
            </div>
          )}
          <button onClick={exportVault} className={`mt-2 ${primaryBtn}`}>
            {exportState === 'done' ? t('postRegister.downloadAgain') : t('postRegister.download')}
          </button>

          <label className={`flex items-center gap-2 text-xs leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted'}`}>
            <input type="checkbox" checked={savedConfirmed} onChange={(e) => setSavedConfirmed(e.target.checked)} />
            {t('postRegister.savedConfirm')}
          </label>

          <button
            onClick={afterBackup}
            disabled={!savedConfirmed}
            className={`w-full border px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isRetro ? 'p13-classic-button' : 'border-neon-cyan font-mono tracking-wider text-neon-cyan enabled:bg-neon-cyan/10 enabled:hover:bg-neon-cyan/20'
            }`}
          >
            {canRecovery ? t('postRegister.continueToRecovery') : t('postRegister.continue')}
          </button>

          <div className="space-y-1 pt-1">
            <button onClick={onDismiss} className={mutedBtn}>{t('postRegister.skip')}</button>
            <p className={`text-[11px] leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted/60'}`}>
              {t('postRegister.skipConsequence')}
            </p>
          </div>
        </div>
      ) : (
        <div className={cardClass}>
          {stepDots}
          <div className={titleClass}>{t('postRegister.recoveryTitle')}</div>
          <p className="text-sm leading-relaxed text-text-muted">{t('postRegister.recoveryBody')}</p>

          {recoveryBusy && !enrollment ? (
            <p className="py-6 text-center text-xs text-text-muted animate-pulse">{t('postRegister.recoveryGenerating')}</p>
          ) : enrollment ? (
            <>
              <div
                className={`grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 text-xs sm:grid-cols-3 ${
                  isRetro ? 'p13-classic-input' : 'border border-border-strong bg-[color-mix(in_srgb,var(--void)_60%,transparent)]'
                }`}
              >
                {enrollment.mnemonic.split(' ').map((word, i) => (
                  <span key={i} className="flex gap-1.5">
                    <span className="select-none text-text-muted/50 tabular-nums">{i + 1}.</span>
                    <span className={isRetro ? 'p13-classic-copy' : 'text-text-primary'}>{word}</span>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <button onClick={downloadPhrase} className={`flex-1 ${primaryBtn}`}>{t('postRegister.recoveryDownload')}</button>
                <button onClick={copyPhrase} className={`flex-1 ${mutedBtn}`}>
                  {phraseCopied ? t('postRegister.recoveryCopied') : t('postRegister.recoveryCopy')}
                </button>
              </div>

              <label className={`flex items-center gap-2 text-xs leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted'}`}>
                <input type="checkbox" checked={phraseSaved} onChange={(e) => setPhraseSaved(e.target.checked)} />
                {t('postRegister.recoverySavedConfirm')}
              </label>

              {recoveryError && (
                <div className="border border-neon-red/50 bg-neon-red/10 p-3 text-xs leading-relaxed text-neon-red">
                  {recoveryError}
                </div>
              )}

              <button
                onClick={enableRecoveryAndFinish}
                disabled={!phraseSaved || recoveryBusy}
                className={`w-full border px-3 py-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  isRetro ? 'p13-classic-button' : 'border-neon-cyan font-mono tracking-wider text-neon-cyan enabled:bg-neon-cyan/10 enabled:hover:bg-neon-cyan/20'
                }`}
              >
                {recoveryBusy ? t('postRegister.recoveryEnabling') : t('postRegister.recoveryEnable')}
              </button>
            </>
          ) : (
            recoveryError && (
              <div className="border border-neon-red/50 bg-neon-red/10 p-3 text-xs leading-relaxed text-neon-red">
                {recoveryError}
              </div>
            )
          )}

          <div className="space-y-1 pt-1">
            <button onClick={onDismiss} className={mutedBtn}>{t('postRegister.recoverySkip')}</button>
            <p className={`text-[11px] leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted/60'}`}>
              {t('postRegister.recoverySkipNote')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

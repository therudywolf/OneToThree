'use client'

import { useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { useTranslation } from '@/hooks/use-translation'
import { readVaultBlob } from '@/lib/vault'
import { useThemeStore } from '@/store/themeStore'
import { useFocusTrap } from '@/hooks/use-focus-trap'

/**
 * Модальник после регистрации — предлагает сохранить резервную копию аккаунта.
 * Вызывается из login-form.tsx после успешного GENESIS.
 * onDismiss — закрыть (продолжить вход).
 */
export function PostRegisterVaultPrompt({
  onDismiss,
}: {
  onDismiss: () => void
}) {
  const { user } = useAuth()
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const [exportState, setExportState] = useState<'idle' | 'done' | 'error'>('idle')
  const [savedConfirmed, setSavedConfirmed] = useState(false)
  // D27 — ESC + focus trap + body-scroll-lock + focus restore.
  const trapRef = useFocusTrap<HTMLDivElement>(true, onDismiss)

  function exportVault() {
    const userId = user?.id
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
    // Downloading naturally satisfies the "I've saved my backup" confirmation.
    setSavedConfirmed(true)
  }

  const overlayClass = isMd3
    ? 'bg-[color-mix(in_srgb,var(--void)_65%,transparent)] backdrop-blur-sm'
    : isRetro
      ? 'p13-classic-overlay'
      : 'bg-[color-mix(in_srgb,var(--void)_85%,transparent)]'

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('postRegister.title')}
      className={`fixed inset-0 z-[120] flex items-center justify-center px-6 py-8 ${overlayClass}`}
    >
      <div className={`w-full max-w-md space-y-4 p-8 ${
        isMd3
          ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
          : isRetro
            ? 'p13-classic-window'
            : 'border border-neon-cyan/50 bg-void font-mono'
      }`}>
        <div className={`text-sm ${isMd3 ? 'text-[var(--on-surface)] tracking-normal' : isRetro ? 'p13-classic-copy' : 'text-neon-cyan'}`}>
          {t('postRegister.title')}
        </div>
        <p className="text-sm leading-relaxed text-text-muted">
          {t('postRegister.body')}
        </p>
        <p className="text-xs leading-relaxed text-text-muted">
          {t('postRegister.encryptedNote')}
        </p>
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
        <button
          onClick={exportVault}
          className={`mt-2 w-full border px-3 py-3 text-xs transition-colors ${
            isRetro
              ? 'p13-classic-button'
              : 'border-neon-cyan bg-neon-cyan/5 font-mono tracking-wider text-neon-cyan hover:bg-neon-cyan/10'
          }`}
        >
          {exportState === 'done' ? t('postRegister.downloadAgain') : t('postRegister.download')}
        </button>

        <label className={`flex items-center gap-2 text-xs leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted'}`}>
          <input
            type="checkbox"
            checked={savedConfirmed}
            onChange={(e) => setSavedConfirmed(e.target.checked)}
          />
          {t('postRegister.savedConfirm')}
        </label>

        <button
          onClick={onDismiss}
          disabled={!savedConfirmed}
          className={`w-full border px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            isRetro
              ? 'p13-classic-button'
              : 'border-neon-cyan font-mono tracking-wider text-neon-cyan enabled:bg-neon-cyan/10 enabled:hover:bg-neon-cyan/20'
          }`}
        >
          {t('postRegister.continue')}
        </button>

        <div className="space-y-1 pt-1">
          <button
            onClick={onDismiss}
            className={`w-full border px-3 py-2 text-xs ${isRetro ? 'p13-classic-button p13-classic-button--muted' : 'border-border-strong bg-transparent font-mono tracking-wider text-text-muted/70 hover:text-text-muted'}`}
          >
            {t('postRegister.skip')}
          </button>
          <p className={`text-[11px] leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted/60'}`}>
            {t('postRegister.skipConsequence')}
          </p>
        </div>
      </div>
    </div>
  )
}

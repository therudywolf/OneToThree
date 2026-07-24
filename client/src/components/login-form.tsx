'use client'
import { markBackupPending } from '@/lib/backup-reminder'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/components/auth/auth-provider'
import { cryptoLogin, finalizeLoginWithTotp } from '@/lib/auth/crypto-login'
import { recoverWithPhrase } from '@/lib/auth/crypto-recover'
import { ensureClientDeviceId, clearSessionApi } from '@/lib/api/auth'
import { parseNickname } from '@/lib/nickname'
import { persistVaultBlobByLoginUsername, type VaultBlob } from '@/lib/vault'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'
import { PostRegisterVaultPrompt } from '@/components/post-register-vault-prompt'
import { explainLoginError } from '@/lib/login-errors'
import { useThemeStore } from '@/store/themeStore'

/**
 * AUTH MODEL (honest)
 * ===================
 * Единственный секрет = vault-password.
 * AES-GCM(PBKDF2(vault-password)) → ECDSA ключ → localStorage.
 * vault-файл переносим: импорт .key → тот же пароль работает.
 * Сервер пароль не знает. Второй фактор = TOTP.
 *
 * Стадии:
 *   IDENTITY — никнейм + vault-password (+ повтор при регистрации)
 *   MFA_SYNC — TOTP если включён
 */

type FormStage = 'IDENTITY' | 'MFA_SYNC' | 'RECOVER'
type FormMode  = 'ACCESS'   | 'GENESIS'

const iconProps = {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

function EyeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10.7 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.2 4.1M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 5.4-1.4" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m2 2 20 20" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg {...iconProps} width={11} height={11}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/**
 * `initialMode` comes from the ROUTE (/login vs /register) so the two are real,
 * bookmarkable, back-button-able screens rather than one page with hidden state.
 * The in-card toggle still switches instantly (no reload) and keeps the URL
 * honest via router.replace.
 */
export function LoginForm({ initialMode = 'ACCESS' }: { initialMode?: FormMode } = {}) {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()

  const [handle, setHandle]         = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [confirmVaultPassword, setConfirmVaultPassword] = useState('')

  const [mode, setMode]   = useState<FormMode>(initialMode)
  const [stage, setStage] = useState<FormStage>('IDENTITY')

  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode]         = useState('')

  // Recovery (Option A)
  const [recoverPhrase, setRecoverPhrase]           = useState('')
  const [recoverNewPassword, setRecoverNewPassword] = useState('')
  const [recoverConfirm, setRecoverConfirm]         = useState('')
  const [recoverTotpCode, setRecoverTotpCode]       = useState('')
  const [recoverNeedsTotp, setRecoverNeedsTotp]     = useState(false)
  const [errorLog, setErrorLog]         = useState<string | null>(null)
  const [infoLog, setInfoLog]           = useState<string | null>(null)
  const [isBusy, setIsBusy]             = useState(false)
  const [vaultLinkOk, setVaultLinkOk]   = useState(false)
  const [staleSession, setStaleSession] = useState(false)
  const [showVaultPrompt, setShowVaultPrompt] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  const lock = useRef(false)

  useEffect(() => { ensureClientDeviceId() }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('expired') === '1') {
      setStaleSession(true)
      clearSessionApi().catch(() => {})
      const clean = new URL(window.location.href)
      clean.searchParams.delete('expired')
      window.history.replaceState({}, '', clean.pathname + clean.search)
    }
  }, [])

  useEffect(() => {
    if (showVaultPrompt) return
    if (!authLoading && user) {
      const params = new URLSearchParams(window.location.search)
      const inviteCode = params.get('code')?.trim()
      router.replace(inviteCode ? `/join/${encodeURIComponent(inviteCode)}` : '/')
    }
  }, [authLoading, user, router, showVaultPrompt])

  const resetForm = () => {
    setVaultPassword('')
    setConfirmVaultPassword('')
    setErrorLog(null)
    setInfoLog(null)
  }

  const handleVaultImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.key'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setErrorLog(null)
      try {
        const raw = JSON.parse(await file.text()) as {
          username?: string | null
          userId?: string | null
          vault?: VaultBlob
          ciphertextB64?: string  // raw blob (no wrapper)
          saltB64?: string
          ivB64?: string
          version?: number
        }

        // Support both wrapped { vault: VaultBlob } and raw VaultBlob formats
        const blob: VaultBlob | null = raw.vault?.ciphertextB64
          ? raw.vault
          : raw.ciphertextB64 && raw.saltB64 && raw.ivB64
          ? (raw as unknown as VaultBlob)
          : null

        if (!blob?.ciphertextB64) {
          setErrorLog(t('login.importFailedFormat'))
          return
        }

        // Prefer explicit username → fall back to handle field
        const nameCandidate = raw.username?.trim() || handle.trim()
        if (!nameCandidate) {
          setErrorLog(t('login.importNeedUsername'))
          return
        }
        const nick = parseNickname(nameCandidate)
        if (!nick.ok) {
          setErrorLog(t('login.importFailedFormat'))
          return
        }
        persistVaultBlobByLoginUsername(nick.value, blob)
        setHandle(nick.value)
        setVaultLinkOk(true)
      } catch (e) {
        console.error('[vault-import]', e)
        setErrorLog(t('settings.importFailed') + ': ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    input.click()
  }

  const execAuthProtocol = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy) return
    lock.current = true
    setErrorLog(null)
    setInfoLog(null)
    setIsBusy(true)
    try {
      if (mode === 'GENESIS' && vaultPassword !== confirmVaultPassword) {
        setErrorLog(t('login.passwordMismatch'))
        return
      }
      const res = await cryptoLogin({
        username: handle,
        vaultPassword,
        mode: mode === 'ACCESS' ? 'login' : 'register',
      })
      if (res.ok === 'needs_2fa') {
        setPendingToken(res.pendingToken)
        setStage('MFA_SYNC')
        return
      }
      if (!res.ok) {
        if (res.error === 'USERNAME_TAKEN' || res.error === 'PUBLIC_KEY_CONFLICT') {
          setInfoLog(t('login.accountExists'))
          return
        }
        setErrorLog(explainLoginError(res.error, t))
        return
      }
      if (mode === 'GENESIS') {
        // Nothing is backed up yet, by definition. The prompt below is skippable
        // on purpose, so record that fact — otherwise one Esc silently discards
        // the only warning the product ever gives, and server-side vault restore
        // no longer exists (the endpoints return 410).
        if (res.user?.id) markBackupPending(res.user.id)
        // Keep the post-register backup prompt mounted before auth refresh,
        // otherwise the auto-redirect effect can win the race and hide it.
        setShowVaultPrompt(true)
        await refresh()
        return
      }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg === 'USERNAME_TAKEN' || msg === 'PUBLIC_KEY_CONFLICT') {
        setInfoLog(t('login.accountExists'))
        return
      }
      setErrorLog(explainLoginError(msg || 'SYS_FAULT', t))
    } finally {
      setIsBusy(false)
      lock.current = false
    }
  }

  const execMfaSync = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy || !pendingToken) return
    lock.current = true
    setErrorLog(null)
    setIsBusy(true)
    try {
      const r = await finalizeLoginWithTotp({
        pendingToken,
        code: totpCode.replace(/\D/g, '').slice(0, 6),
        canonicalHandle: handle.trim(),
        // Still in state from the first step — hand it over so 2FA users also
        // skip the redundant second password prompt.
        vaultPassword,
      })
      if (!r.ok) { setErrorLog(explainLoginError(r.error, t)); return }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      setErrorLog(explainLoginError(err instanceof Error ? err.message : 'MFA_FAULT', t))
    } finally {
      setIsBusy(false)
      lock.current = false
    }
  }

  const openRecover = () => {
    setStage('RECOVER')
    setRecoverPhrase('')
    setRecoverNewPassword('')
    setRecoverConfirm('')
    setRecoverTotpCode('')
    setRecoverNeedsTotp(false)
    setErrorLog(null)
    setInfoLog(null)
  }

  const execRecover = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy) return
    lock.current = true
    setErrorLog(null)
    setInfoLog(null)
    setIsBusy(true)
    try {
      if (recoverNewPassword !== recoverConfirm) {
        setErrorLog(t('login.passwordMismatch'))
        return
      }
      const res = await recoverWithPhrase({
        username: handle,
        phrase: recoverPhrase,
        newPassword: recoverNewPassword,
        totpCode: recoverNeedsTotp ? recoverTotpCode.replace(/\D/g, '').slice(0, 6) : undefined,
      })
      // The re-sealed vault still triggers login-level 2FA when the account
      // has TOTP enabled — forward to the MFA stage exactly like a normal login.
      if (res.ok === 'needs_2fa') {
        setPendingToken(res.pendingToken)
        setStage('MFA_SYNC')
        return
      }
      if (!res.ok) {
        // Recovery opted into a TOTP step-up: reveal the code field and retry.
        if (res.error === 'TOTP_STEP_UP_REQUIRED' || res.error === 'TOTP_INVALID') {
          setRecoverNeedsTotp(true)
        }
        setErrorLog(explainLoginError(res.error, t))
        return
      }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      setErrorLog(explainLoginError(err instanceof Error ? err.message : 'SYS_FAULT', t))
    } finally {
      setIsBusy(false)
      lock.current = false
    }
  }

  if (authLoading) return (
    <div className="border border-border-strong bg-void p-6 font-mono text-[10px] uppercase tracking-[0.4em] text-text-muted/70 animate-pulse">
      {t('login.authLoading')}
    </div>
  )

  return (
    <>
      {showVaultPrompt && (
        <PostRegisterVaultPrompt
          vaultPassword={vaultPassword}
          onDismiss={() => { setShowVaultPrompt(false); router.refresh() }}
        />
      )}

      <AnimatePresence mode="wait">

        {/* ── TOTP ── */}
        {stage === 'MFA_SYNC' && (
          <motion.form
            key="mfa"
            onSubmit={execMfaSync}
            className={`relative w-full max-w-sm p-8 ${
              isMd3
                ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
                : isRetro
                  ? 'p13-classic-window'
                  : 'border border-border-strong bg-void shadow-2xl'
            }`}
            initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
          >
            <header className={`mb-8 border-b pb-4 ${isRetro ? 'p13-classic-titlebar px-2 pt-2' : 'border-border-strong'}`}>
              <p className={`text-[10px] ${isMd3 ? 'tracking-normal text-[var(--on-surface)]' : isRetro ? 'p13-classic-title-copy' : 'uppercase tracking-[0.4em] text-neon-cyan'}`}>{t('login.totpTitle')}</p>
            </header>
            <div className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="totp" className="text-[9px] uppercase tracking-widest text-text-muted">
                  {t('login.totpCodeLabel')}
                </label>
                <input
                  id="totp" type="text" inputMode="numeric" maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className={`w-full p-3 text-xl text-center outline-none ${
                    isMd3
                      ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] tracking-[0.3em] text-[var(--on-surface)]'
                      : isRetro
                        ? 'p13-classic-input tracking-[0.35em] p-3'
                        : 'bg-void border border-border-strong font-mono tracking-[0.6em] text-neon-cyan focus:border-neon-cyan/50'
                  }`}
                  placeholder="000000" autoComplete="one-time-code" autoFocus
                />
              </div>
              {errorLog && (
                <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">{errorLog}</div>
              )}
              <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                {t('login.totpSubmit')}
              </TerminalGlitchButton>
              <button type="button" onClick={() => setStage('IDENTITY')}
                className={`w-full text-[9px] ${isRetro ? 'p13-classic-copy-muted hover:text-[var(--neon-red)]' : 'uppercase tracking-widest text-text-muted/70 hover:text-neon-red'}`}>
                {t('common.back')}
              </button>
            </div>
          </motion.form>
        )}

        {/* ── RECOVER (Option A) ── */}
        {stage === 'RECOVER' && (
          <motion.form
            key="recover"
            onSubmit={execRecover}
            className={`relative w-full max-w-sm p-8 ${
              isMd3
                ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
                : isRetro
                  ? 'p13-classic-window'
                  : 'border border-border-strong bg-void shadow-2xl'
            }`}
            initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
          >
            <header className={`mb-6 border-b pb-4 ${isRetro ? 'p13-classic-titlebar px-2 pt-2' : 'border-border-strong'}`}>
              <p className={`text-[10px] ${isMd3 ? 'tracking-normal text-[var(--on-surface)]' : isRetro ? 'p13-classic-title-copy' : 'uppercase tracking-[0.4em] text-neon-cyan'}`}>{t('login.recoverTitle')}</p>
              <p className={`mt-1 text-[8px] ${isRetro ? 'p13-classic-title-copy-soft tracking-normal' : 'text-text-muted/70 tracking-widest'}`}>{t('login.recoverSubtitle')}</p>
            </header>

            <div className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="recover-username" className="terminal-label">{t('login.handleLabel')}</label>
                <input id="recover-username" type="text" required autoFocus
                  value={handle} onChange={(e) => setHandle(e.target.value)}
                  className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                  placeholder={t('login.handlePlaceholder')} autoComplete="username" />
              </div>

              <div className="space-y-2">
                <label htmlFor="recover-phrase" className="terminal-label">{t('login.recoverPhraseLabel')}</label>
                <textarea id="recover-phrase" required rows={3}
                  value={recoverPhrase} onChange={(e) => setRecoverPhrase(e.target.value)}
                  className={`${isRetro ? 'p13-classic-input' : 'terminal-input'} w-full resize-none px-3 py-2 text-[11px] outline-none`}
                  placeholder={t('login.recoverPhrasePlaceholder')} autoComplete="off" spellCheck={false} />
              </div>

              <div className="space-y-2">
                <label htmlFor="recover-new-pass" className="terminal-label">{t('login.recoverNewPassword')}</label>
                <input id="recover-new-pass" type="password" required
                  value={recoverNewPassword} onChange={(e) => setRecoverNewPassword(e.target.value)}
                  className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                  placeholder="••••••••" autoComplete="new-password" />
              </div>

              <div className="space-y-2">
                <label htmlFor="recover-confirm" className="terminal-label">{t('common.confirm')}</label>
                <input id="recover-confirm" type="password" required
                  value={recoverConfirm} onChange={(e) => setRecoverConfirm(e.target.value)}
                  className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                  placeholder="••••••••" autoComplete="new-password" />
              </div>

              {recoverNewPassword.length > 0 && recoverNewPassword.length < 8 && (
                <p className="border-l-2 border-neon-cyan/40 bg-neon-cyan/5 p-3 text-[9px] text-text-muted">
                  <span className="font-bold text-neon-cyan">{t('login.pinMinTip')}</span> {t('login.pinMin8')}
                </p>
              )}

              {recoverNeedsTotp && (
                <div className="space-y-2">
                  <label htmlFor="recover-totp" className="terminal-label">{t('login.totpCodeLabel')}</label>
                  <input id="recover-totp" type="text" inputMode="numeric" maxLength={6}
                    value={recoverTotpCode} onChange={(e) => setRecoverTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                    placeholder="000000" autoComplete="one-time-code" />
                </div>
              )}

              {errorLog && (
                <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">{errorLog}</div>
              )}

              <div className="flex flex-col gap-3 pt-2">
                <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                  {isBusy ? '...' : t('login.recoverSubmit')}
                </TerminalGlitchButton>
                <button type="button" onClick={() => { setStage('IDENTITY'); setErrorLog(null) }}
                  className={`w-full text-[9px] ${isRetro ? 'p13-classic-copy-muted hover:text-[var(--neon-red)]' : 'uppercase tracking-widest text-text-muted/70 hover:text-neon-red'}`}>
                  {t('common.back')}
                </button>
              </div>
            </div>
          </motion.form>
        )}

        {/* ── IDENTITY / GENESIS ── */}
        {stage === 'IDENTITY' && (
          <motion.form
            key="identity"
            onSubmit={execAuthProtocol}
            className={`relative w-full max-w-sm p-8 ${
              isMd3
                ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
                : isRetro
                  ? 'p13-classic-window'
                  : 'border border-border-strong bg-void shadow-2xl'
            }`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          >
            <div className={`absolute top-0 left-0 h-[1px] w-full ${isRetro ? 'p13-classic-accent-fill opacity-100' : 'bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50'}`} />

            <header className={`mb-8 border-b pb-4 ${isRetro ? 'p13-classic-titlebar px-2 pt-2' : 'border-border-strong'}`}>
              <p className={`text-[10px] ${isMd3 ? 'tracking-normal text-[var(--on-surface)]' : isRetro ? 'p13-classic-title-copy' : 'uppercase tracking-[0.4em] text-neon-cyan'}`}>
                {mode === 'ACCESS' ? t('login.entryHeadingSignIn') : t('login.entryHeadingCreate')}
              </p>
              <p className={`mt-1 text-[8px] ${isRetro ? 'p13-classic-title-copy-soft tracking-normal' : 'text-text-muted/70 tracking-wide'}`}>{t('login.authReassure')}</p>
            </header>

            {/* Sign in / Create account — clear two-option control */}
            <div className={`mb-6 grid grid-cols-2 gap-1 p-1 ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : isRetro
                  ? 'p13-classic-input'
                  : 'border border-border-strong bg-void'
            }`}>
              {([
                ['ACCESS', t('login.tabSignIn')] as const,
                ['GENESIS', t('login.tabCreate')] as const,
              ]).map(([m, label]) => {
                const active = mode === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if (mode === m) return
                      setMode(m)
                      resetForm()
                      // Keep the address bar truthful so /login and /register are
                      // real screens (shareable, back-button-able) even though
                      // the switch itself is instant.
                      router.replace(m === 'GENESIS' ? '/register' : '/login')
                    }}
                    aria-pressed={active}
                    className={`py-2 text-[10px] tracking-wide transition-all ${
                      isMd3
                        ? `rounded-full ${active ? 'bg-[var(--surface)] font-medium text-[var(--on-surface)] shadow-[var(--md3-elevation-1)]' : 'text-text-muted'}`
                        : isRetro
                          ? (active ? 'p13-classic-accent-fill text-text-primary' : 'p13-classic-copy-muted')
                          : `uppercase tracking-widest ${active ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-text-muted/70 hover:text-neon-cyan'}`
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            <div className="space-y-6">

              {/* TOS при регистрации — короткая строка + раскрываемые детали */}
              {mode === 'GENESIS' && (
                <div className={`p-3 text-[9px] leading-relaxed ${isRetro ? 'p13-classic-input' : 'border border-border-strong bg-void/50 text-text-muted'}`}>
                  <p>{t('login.tosShort')}</p>
                  <details className="mt-1">
                    <summary className={`cursor-pointer text-[9px] ${isRetro ? 'p13-classic-copy-muted' : 'text-neon-cyan/80 hover:text-neon-cyan'}`}>
                      {t('login.tosReadMore')}
                    </summary>
                    <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-line pr-2 text-[9px] leading-relaxed text-text-muted custom-scrollbar">
                      {t('login.tosRegisterBody')}
                    </div>
                  </details>
                </div>
              )}

              {/* Никнейм */}
              <div className="space-y-2">
                <label htmlFor="username" className="terminal-label">{t('login.handleLabel')}</label>
                <input
                  id="username"
                  type="text" required autoFocus
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                  placeholder={t('login.handlePlaceholder')}
                  autoComplete="username"
                />
                {mode === 'GENESIS' && (
                  <p className={`text-[8px] ${isRetro ? 'p13-classic-copy-muted' : 'text-text-muted/70'}`}>{t('login.usernameHint')}</p>
                )}
              </div>

              {/* Account password */}
              <div className="space-y-2">
                {mode === 'GENESIS' && (
                  <div id="password-explain" className="border-l-2 border-neon-cyan/40 pl-3 space-y-1 mb-3">
                    <p className="text-[8px] text-text-muted leading-relaxed">
                      {t('login.vaultPasswordExplain1')}
                    </p>
                    <p className="text-[8px] text-text-muted/70 leading-relaxed">
                      {t('login.vaultPasswordExplain2')}
                    </p>
                  </div>
                )}
                <label htmlFor="password" className="terminal-label">
                  {t('login.passwordLabel')}
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'} required
                    value={vaultPassword}
                    onChange={(e) => setVaultPassword(e.target.value)}
                    className={`${isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'} pr-10`}
                    placeholder="••••••••"
                    autoComplete={mode === 'ACCESS' ? 'current-password' : 'new-password'}
                    aria-describedby={mode === 'GENESIS' ? 'password-explain' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t('login.passwordHide') : t('login.passwordShow')}
                    title={showPassword ? t('login.passwordHide') : t('login.passwordShow')}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted/70 hover:text-neon-cyan transition-colors"
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              {/* Повтор пароля при регистрации */}
              {mode === 'GENESIS' && (
                <div className="space-y-2">
                  <label htmlFor="confirmPassword" className="terminal-label">{t('common.confirm')}</label>
                  <input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'} required
                    value={confirmVaultPassword}
                    onChange={(e) => setConfirmVaultPassword(e.target.value)}
                    className={isRetro ? 'p13-classic-input w-full px-3 py-2 text-[11px] outline-none' : 'terminal-input'}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                  {confirmVaultPassword.length > 0 && (
                    vaultPassword === confirmVaultPassword ? (
                      <p className="flex items-center gap-1 text-[8px] text-neon-cyan">
                        <CheckIcon /> {t('login.passwordsMatch')}
                      </p>
                    ) : (
                      <p className="text-[8px] text-neon-red/80">{t('login.passwordsDiffer')}</p>
                    )
                  )}
                </div>
              )}

              {/* Подсказка о длине пароля */}
              {mode === 'GENESIS' && vaultPassword.length > 0 && vaultPassword.length < 8 && (
                <p className="border-l-2 border-neon-cyan/40 bg-neon-cyan/5 p-3 text-[9px] text-text-muted">
                  <span className="font-bold text-neon-cyan">{t('login.pinMinTip')}</span> {t('login.pinMin8')}
                </p>
              )}

              {staleSession && !errorLog && !infoLog && (
                <div className="border border-neon-cyan/40 bg-neon-cyan/5 p-2 text-[9px] text-neon-cyan font-mono">
                  {t('login.sessionExpired')}
                </div>
              )}

              {infoLog && (
                <div className="border border-neon-cyan/40 bg-neon-cyan/5 p-2 text-[9px] text-neon-cyan font-mono flex items-center justify-between gap-2">
                  <span>{infoLog}</span>
                  <button type="button"
                    onClick={() => { setMode('ACCESS'); setInfoLog(null) }}
                    className="shrink-0 border border-neon-cyan/50 px-2 py-0.5 text-[8px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 transition-colors">
                    {t('login.accountExistsAction')}
                  </button>
                </div>
              )}

              {errorLog && (
                <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">{errorLog}</div>
              )}

              <div className="flex flex-col gap-4 pt-4">
                <TerminalGlitchButton
                  type="submit"
                  disabled={isBusy}
                  aria-label={mode === 'ACCESS' ? t('login.signIn') : t('login.register')}
                  className="w-full"
                >
                  {mode === 'ACCESS' ? t('login.signIn') : (isBusy ? '...' : t('login.register'))}
                </TerminalGlitchButton>
              </div>

              {mode === 'ACCESS' && (
                <div className="mt-6 border-t border-border-strong pt-6 space-y-3">
                  <button type="button" onClick={handleVaultImport}
                    className="w-full border border-border-strong bg-void py-2 text-[9px] uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan transition-all">
                    {t('login.vaultRecoveryImport')}
                  </button>
                  {vaultLinkOk && (
                    <p className="mt-2 text-[8px] text-neon-cyan animate-pulse">{t('login.vaultRecoveryOk')}</p>
                  )}
                  <button type="button" onClick={openRecover}
                    className="w-full border border-neon-cyan/40 bg-void py-2 text-[9px] uppercase tracking-widest text-neon-cyan/90 hover:bg-neon-cyan/10 transition-all">
                    {t('login.recoverLink')}
                  </button>
                  <button type="button"
                    onClick={async () => { await clearSessionApi().catch(() => {}); window.location.reload() }}
                    className="w-full text-[8px] uppercase tracking-widest text-text-muted/70 hover:text-text-muted transition-colors">
                    {t('login.clearSession')}
                  </button>
                </div>
              )}
            </div>
          </motion.form>
        )}

      </AnimatePresence>
    </>
  )
}

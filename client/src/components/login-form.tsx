'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/components/auth/auth-provider'
import { cryptoLogin, finalizeLoginWithTotp } from '@/lib/auth/crypto-login'
import { ensureClientDeviceId, clearSessionApi } from '@/lib/api/auth'
import { parseNickname } from '@/lib/nickname'
import { persistVaultBlobByLoginUsername, type VaultBlob } from '@/lib/vault'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'
import { PostRegisterVaultPrompt } from '@/components/post-register-vault-prompt'

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

type FormStage = 'IDENTITY' | 'MFA_SYNC'
type FormMode  = 'ACCESS'   | 'GENESIS'

export function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()

  const [handle, setHandle]         = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [confirmVaultPassword, setConfirmVaultPassword] = useState('')

  const [mode, setMode]   = useState<FormMode>('ACCESS')
  const [stage, setStage] = useState<FormStage>('IDENTITY')

  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode]         = useState('')
  const [errorLog, setErrorLog]         = useState<string | null>(null)
  const [infoLog, setInfoLog]           = useState<string | null>(null)
  const [isBusy, setIsBusy]             = useState(false)
  const [vaultLinkOk, setVaultLinkOk]   = useState(false)
  const [staleSession, setStaleSession] = useState(false)
  const [showVaultPrompt, setShowVaultPrompt] = useState(false)

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

  const mapFault = (code: string): string => {
    const registry: Record<string, string> = {
      USERNAME_REQUIRED:      t('login.usernameRequired'),
      PASSWORD_REQUIRED:      t('login.passwordRequired'),
      PIN_MIN_8:              t('login.pinMin8'),
      NO_LOCAL_VAULT:         t('login.noLocalVault'),
      VAULT_ALREADY_EXISTS:   t('login.vaultExists'),
      UNWRAP_FAILED:          t('login.unwrapFailed'),
      INVALID_VAULT_FORMAT:   t('login.invalidVaultFormat'),
      VAULT_VERSION_MISMATCH: t('login.vaultVersionMismatch'),
      TOTP_INVALID:           t('login.totpInvalid'),
      DEVICE_REVOKED:         t('login.deviceRevoked'),
    }
    return registry[code] ?? code.replace(/_/g, ' ')
  }

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
        const data = JSON.parse(await file.text()) as { username?: string; vault?: VaultBlob }
        if (!data.vault?.ciphertextB64) throw new Error('INVALID_STRUCTURE')
        const nick = parseNickname(data.username?.trim() || handle.trim())
        if (!nick.ok) throw new Error(nick.error)
        persistVaultBlobByLoginUsername(nick.value, data.vault)
        setHandle(nick.value)
        setVaultLinkOk(true)
      } catch {
        setErrorLog(t('settings.importFailed'))
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
        setErrorLog(mapFault(res.error))
        return
      }
      if (mode === 'GENESIS') {
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
      setErrorLog(msg || 'SYS_FAULT')
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
      })
      if (!r.ok) { setErrorLog(mapFault(r.error)); return }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      setErrorLog(err instanceof Error ? err.message : 'MFA_FAULT')
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
          onDismiss={() => { setShowVaultPrompt(false); router.refresh() }}
        />
      )}

      <AnimatePresence mode="wait">

        {/* ── TOTP ── */}
        {stage === 'MFA_SYNC' && (
          <motion.form
            key="mfa"
            onSubmit={execMfaSync}
            className="relative w-full max-w-sm border border-border-strong bg-void p-8 shadow-2xl"
            initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
          >
            <header className="mb-8 border-b border-border-strong pb-4">
              <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">{t('login.totpTitle')}</p>
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
                  className="w-full bg-void border border-border-strong p-3 font-mono text-xl tracking-[0.6em] text-neon-cyan text-center outline-none focus:border-neon-cyan/50"
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
                className="w-full text-[9px] uppercase tracking-widest text-text-muted/70 hover:text-neon-red">
                {t('common.back')}
              </button>
            </div>
          </motion.form>
        )}

        {/* ── IDENTITY / GENESIS ── */}
        {stage === 'IDENTITY' && (
          <motion.form
            key="identity"
            onSubmit={execAuthProtocol}
            className="relative w-full max-w-sm border border-border-strong bg-void p-8 shadow-2xl"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          >
            <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

            <header className="mb-8 border-b border-border-strong pb-4">
              <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
                {mode === 'ACCESS' ? t('login.signIn') : t('login.register')}
              </p>
              <p className="mt-1 text-[8px] text-text-muted/70 tracking-widest">E2E // ECDSA P-256 // ZERO-TRUST</p>
            </header>

            <div className="space-y-6">

              {/* TOS при регистрации */}
              {mode === 'GENESIS' && (
                <div className="border border-border-strong bg-void/50 p-4">
                  <p className="text-[8px] uppercase tracking-widest text-neon-red mb-2">{t('login.tosRegisterTitle')}</p>
                  <div className="max-h-32 overflow-y-auto text-[9px] leading-relaxed text-text-muted pr-2 custom-scrollbar">
                    {t('login.tosRegisterBody')}
                  </div>
                </div>
              )}

              {/* Никнейм */}
              <div className="space-y-2">
                <label className="terminal-label">{t('login.handleLabel')}</label>
                <input
                  id="username"
                  type="text" required autoFocus
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="terminal-input"
                  placeholder={t('login.handlePlaceholder')}
                  autoComplete="username"
                />
              </div>

              {/* Vault-password */}
              <div className="space-y-2">
                {mode === 'GENESIS' && (
                  <div className="border-l-2 border-neon-cyan/40 pl-3 space-y-1 mb-3">
                    <p className="text-[8px] text-text-muted leading-relaxed">
                      Пароль шифрует твой приватный ключ локально.
                      Сервер его не знает и восстановить не может.
                    </p>
                    <p className="text-[8px] text-text-muted/70">
                      Если экспортируешь vault-файл на другое устройство — тот же пароль разблокирует его.
                      Запомни или сохрани — без него нет доступа к аккаунту.
                    </p>
                  </div>
                )}
                <label className="terminal-label">
                  {mode === 'ACCESS' ? t('login.vaultPassphraseLabel') : 'VAULT-ПАРОЛЬ'}
                </label>
                <input
                  id="password"
                  type="password" required
                  value={vaultPassword}
                  onChange={(e) => setVaultPassword(e.target.value)}
                  className="terminal-input"
                  placeholder="••••••••"
                  autoComplete={mode === 'ACCESS' ? 'current-password' : 'new-password'}
                />
              </div>

              {/* Повтор пароля при регистрации */}
              {mode === 'GENESIS' && (
                <div className="space-y-2">
                  <label className="terminal-label">{t('common.confirm')}</label>
                  <input
                    id="confirmPassword"
                    type="password" required
                    value={confirmVaultPassword}
                    onChange={(e) => setConfirmVaultPassword(e.target.value)}
                    className="terminal-input"
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
              )}

              {/* Предупреждение о длине */}
              {mode === 'GENESIS' && vaultPassword.length > 0 && vaultPassword.length < 8 && (
                <p className="border-l-2 border-neon-red bg-neon-red/5 p-3 text-[9px] text-text-muted">
                  <span className="text-neon-red font-bold">WARNING:</span> {t('login.pinMin8')}
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
                  aria-label={mode === 'ACCESS' ? t('login.signIn') : 'REGISTER'}
                  className="w-full"
                >
                  {mode === 'ACCESS' ? t('login.signIn') : (isBusy ? '...' : t('login.register'))}
                </TerminalGlitchButton>
                <button type="button"
                  onClick={() => { setMode(mode === 'ACCESS' ? 'GENESIS' : 'ACCESS'); resetForm() }}
                  aria-label={mode === 'ACCESS' ? 'New device' : t('login.existingVault')}
                  className="text-[9px] uppercase tracking-widest text-text-muted/70 hover:text-neon-cyan transition-colors">
                  {mode === 'ACCESS' ? t('login.newDevice') : t('login.existingVault')}
                </button>
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

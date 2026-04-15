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
 * STAGES (режим ACCESS / вход):
 *   IDENTITY     — никнейм + account-password ("кто ты")
 *   VAULT_UNLOCK — vault-pin ("разблокируй это устройство")
 *   MFA_SYNC     — TOTP (если включён)
 *
 * Режим GENESIS / регистрация:
 *   IDENTITY — один экран, два блока: учётные данные + защита устройства
 */

type FormStage = 'IDENTITY' | 'VAULT_UNLOCK' | 'MFA_SYNC'
type FormMode  = 'ACCESS' | 'GENESIS'

export function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()

  // Учётные данные (шаг 1)
  const [handle, setHandle]       = useState('')
  const [password, setPassword]   = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Vault-pin (шаг 2 при входе / блок 2 при регистрации)
  const [vaultPin, setVaultPin]           = useState('')
  const [confirmVaultPin, setConfirmVaultPin] = useState('')

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
    if (!authLoading && user && !showVaultPrompt) {
      const params = new URLSearchParams(window.location.search)
      const inviteCode = params.get('code')?.trim()
      router.replace(inviteCode ? `/join/${encodeURIComponent(inviteCode)}` : '/')
    }
  }, [authLoading, user, router, showVaultPrompt])

  const mapFault = (code: string): string => {
    const registry: Record<string, string> = {
      USERNAME_REQUIRED:    t('login.usernameRequired'),
      PASSWORD_REQUIRED:    t('login.passwordRequired'),
      PIN_MIN_8:            t('login.pinMin8'),
      NO_LOCAL_VAULT:       t('login.noLocalVault'),
      VAULT_ALREADY_EXISTS: t('login.vaultExists'),
      UNWRAP_FAILED:        t('login.unwrapFailed'),
      INVALID_VAULT_FORMAT: t('login.invalidVaultFormat'),
      VAULT_VERSION_MISMATCH: t('login.vaultVersionMismatch'),
      TOTP_INVALID:         t('login.totpInvalid'),
      DEVICE_REVOKED:       t('login.deviceRevoked'),
    }
    return registry[code] ?? code.replace(/_/g, ' ')
  }

  const resetForm = () => {
    setPassword('')
    setConfirmPassword('')
    setVaultPin('')
    setConfirmVaultPin('')
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

  /**
   * ШАГ 1 (ACCESS): проверяем что vault есть, переходим к VAULT_UNLOCK.
   * GENESIS: полная регистрация сразу.
   */
  const execIdentityStep = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy) return
    setErrorLog(null)
    setInfoLog(null)

    // Регистрация — всё в одном шаге
    if (mode === 'GENESIS') {
      if (password !== confirmPassword) { setErrorLog(t('login.passwordMismatch')); return }
      if (vaultPin !== confirmVaultPin) { setErrorLog(t('login.vaultPasswordMismatch')); return }
      lock.current = true
      setIsBusy(true)
      try {
        const res = await cryptoLogin({
          username: handle,
          password,
          vaultPassword: vaultPin,
          mode: 'register',
        })
        if (res.ok === 'needs_2fa') { setPendingToken(res.pendingToken); setStage('MFA_SYNC'); return }
        if (!res.ok) {
          if (res.error === 'USERNAME_TAKEN' || res.error === 'PUBLIC_KEY_CONFLICT') {
            setInfoLog(t('login.accountExists')); return
          }
          setErrorLog(mapFault(res.error)); return
        }
        await refresh()
        setShowVaultPrompt(true)
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'USERNAME_TAKEN' || msg === 'PUBLIC_KEY_CONFLICT') {
          setInfoLog(t('login.accountExists')); return
        }
        setErrorLog(msg || 'SYS_FAULT')
      } finally {
        setIsBusy(false)
        lock.current = false
      }
      return
    }

    // Вход — переходим к шагу 2 (vault-pin)
    if (!handle.trim()) { setErrorLog(t('login.usernameRequired')); return }
    if (!password)       { setErrorLog(t('login.passwordRequired')); return }
    setStage('VAULT_UNLOCK')
  }

  /**
   * ШАГ 2 (ACCESS): vault-pin → unwrap → ECDSA → сервер.
   */
  const execVaultUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy) return
    lock.current = true
    setErrorLog(null)
    setIsBusy(true)
    try {
      const res = await cryptoLogin({
        username: handle,
        password,
        vaultPassword: vaultPin,
        mode: 'login',
      })
      if (res.ok === 'needs_2fa') { setPendingToken(res.pendingToken); setStage('MFA_SYNC'); return }
      if (!res.ok) { setErrorLog(mapFault(res.error)); return }
      await refresh()
      router.refresh()
    } catch (err) {
      setErrorLog(err instanceof Error ? err.message : 'SYS_FAULT')
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
    } catch (err) {
      setErrorLog(err instanceof Error ? err.message : 'MFA_FAULT')
    } finally {
      setIsBusy(false)
      lock.current = false
    }
  }

  if (authLoading) return (
    <div className="border border-neutral-900 bg-black p-6 font-mono text-[10px] uppercase tracking-[0.4em] text-zinc-600 animate-pulse">
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
            className="relative w-full max-w-sm border border-neutral-900 bg-black p-8 shadow-2xl"
            initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
          >
            <header className="mb-8 border-b border-neutral-900 pb-4">
              <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">{t('login.totpTitle')}</p>
            </header>
            <div className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="totp" className="text-[9px] uppercase tracking-widest text-zinc-500">
                  {t('login.totpCodeLabel')}
                </label>
                <input
                  id="totp" type="text" inputMode="numeric" maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-zinc-950 border border-neutral-900 p-3 font-mono text-xl tracking-[0.6em] text-neon-cyan text-center outline-none focus:border-neon-cyan/50"
                  placeholder="000000" autoComplete="one-time-code" autoFocus
                />
              </div>
              {errorLog && (
                <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">{errorLog}</div>
              )}
              <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                {t('login.totpSubmit')}
              </TerminalGlitchButton>
              <button type="button" onClick={() => setStage('VAULT_UNLOCK')}
                className="w-full text-[9px] uppercase tracking-widest text-zinc-700 hover:text-neon-red">
                {t('common.back')}
              </button>
            </div>
          </motion.form>
        )}

        {/* ── ШАГ 2: РАЗБЛОКИРУЙ УСТРОЙСТВО ── */}
        {stage === 'VAULT_UNLOCK' && mode === 'ACCESS' && (
          <motion.form
            key="vault-unlock"
            onSubmit={execVaultUnlock}
            className="relative w-full max-w-sm border border-neutral-900 bg-black p-8 shadow-2xl"
            initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

            <header className="mb-6 border-b border-neutral-900 pb-4">
              <p className="text-[8px] uppercase tracking-widest text-zinc-600">[ 2 / 2 ]</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.4em] text-neon-cyan">РАЗБЛОКИРУЙ УСТРОЙСТВО</p>
              <p className="mt-1 text-[8px] text-zinc-600">{handle}</p>
            </header>

            <div className="space-y-6">
              <div className="border border-neon-red/20 bg-zinc-950/50 p-3 space-y-1">
                <p className="text-[8px] text-zinc-500 leading-relaxed">
                  Vault-пароль шифрует твой приватный ключ <span className="text-zinc-300">только в этом браузере</span>.
                  Сервер его не знает. Без него ключ не расшифровать.
                </p>
              </div>

              <div className="space-y-2">
                <label className="terminal-label">VAULT-ПАРОЛЬ</label>
                <input
                  type="password" required autoFocus
                  value={vaultPin}
                  onChange={(e) => setVaultPin(e.target.value)}
                  className="terminal-input"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              {errorLog && (
                <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">{errorLog}</div>
              )}

              <div className="flex flex-col gap-3">
                <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                  {isBusy ? '...' : '[ РАЗБЛОКИРОВАТЬ ]'}
                </TerminalGlitchButton>
                <button
                  type="button"
                  onClick={() => { setStage('IDENTITY'); setVaultPin(''); setErrorLog(null) }}
                  className="text-[9px] uppercase tracking-widest text-zinc-600 hover:text-neon-cyan transition-colors"
                >
                  {t('common.back')}
                </button>
              </div>

              <div className="border-t border-neutral-900 pt-4">
                <button type="button" onClick={handleVaultImport}
                  className="w-full border border-neutral-800 bg-zinc-950 py-2 text-[9px] uppercase tracking-widest text-zinc-500 hover:border-neon-cyan hover:text-neon-cyan transition-all">
                  {t('login.vaultRecoveryImport')}
                </button>
                {vaultLinkOk && (
                  <p className="mt-2 text-[8px] text-neon-cyan animate-pulse">{t('login.vaultRecoveryOk')}</p>
                )}
              </div>
            </div>
          </motion.form>
        )}

        {/* ── ШАГ 1 / РЕГИСТРАЦИЯ ── */}
        {stage === 'IDENTITY' && (
          <motion.form
            key="identity"
            onSubmit={execIdentityStep}
            className={`relative w-full border border-neutral-900 bg-black p-8 shadow-2xl transition-all duration-500 ${
              mode === 'GENESIS' ? 'max-w-xl' : 'max-w-sm'
            }`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          >
            <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

            <header className="mb-8 border-b border-neutral-900 pb-4">
              {mode === 'ACCESS' && (
                <p className="text-[8px] uppercase tracking-widest text-zinc-600">[ 1 / 2 ]</p>
              )}
              <p className="mt-1 text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
                {mode === 'ACCESS' ? 'КТО ТЫ' : t('login.register')}
              </p>
              <p className="mt-1 text-[8px] text-zinc-600 tracking-widest">E2E // ECDSA P-256 // ZERO-TRUST</p>
            </header>

            <div className="space-y-6">

              {/* TOS при регистрации */}
              {mode === 'GENESIS' && (
                <div className="border border-zinc-900 bg-zinc-950/50 p-4">
                  <p className="text-[8px] uppercase tracking-widest text-neon-red mb-2">{t('login.tosRegisterTitle')}</p>
                  <div className="max-h-32 overflow-y-auto text-[9px] leading-relaxed text-zinc-500 pr-2 custom-scrollbar">
                    {t('login.tosRegisterBody')}
                  </div>
                </div>
              )}

              {/* Никнейм */}
              <div className="space-y-2">
                <label className="terminal-label">{t('login.handleLabel')}</label>
                <input
                  type="text" required autoFocus
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="terminal-input"
                  placeholder={t('login.handlePlaceholder')}
                  autoComplete="username"
                />
              </div>

              {/* БЛОК 1 :: УЧЁТНЫЕ ДАННЫЕ */}
              {mode === 'GENESIS' ? (
                <>
                  <div className="space-y-4 border border-neon-cyan/20 p-4 animate-in fade-in slide-in-from-top-1">
                    <div>
                      <p className="text-[9px] uppercase tracking-widest text-neon-cyan mb-1">
                        [ БЛОК 1 :: УЧЁТНЫЕ ДАННЫЕ ]
                      </p>
                      <p className="text-[8px] text-zinc-500 leading-relaxed">
                        Вводишь при каждом входе на <span className="text-zinc-300">любом устройстве</span>.
                        Сервер его не знает — используется только для ECDSA-подписи локально.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="terminal-label">{t('login.accountPasswordLabel')}</label>
                      <input
                        type="password" required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="terminal-input"
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="terminal-label">{t('common.confirm')}</label>
                      <input
                        type="password" required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="terminal-input"
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    </div>
                    {password.length > 0 && password.length < 8 && (
                      <p className="text-[9px] text-neon-red">[!] {t('login.pinMin8')}</p>
                    )}
                  </div>

                  {/* БЛОК 2 :: ЗАЩИТА УСТРОЙСТВА */}
                  <div className="space-y-4 border border-neon-red/30 p-4 animate-in fade-in slide-in-from-top-1">
                    <div>
                      <p className="text-[9px] uppercase tracking-widest text-neon-red mb-1">
                        [ БЛОК 2 :: ЗАЩИТА ЭТОГО УСТРОЙСТВА ]
                      </p>
                      <p className="text-[8px] text-zinc-500 leading-relaxed">
                        Только для <span className="text-zinc-300">этого браузера</span>.
                        Шифрует твой приватный ключ локально. Сервер не знает, восстановить невозможно.
                      </p>
                      <p className="mt-1 text-[8px] text-zinc-600 border-l-2 border-neon-red/30 pl-2">
                        Может совпадать с учётным паролем — или быть отдельным. Второй вариант безопаснее.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="terminal-label">VAULT-ПАРОЛЬ</label>
                      <input
                        type="password" required
                        value={vaultPin}
                        onChange={(e) => setVaultPin(e.target.value)}
                        className="terminal-input"
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="terminal-label">{t('common.confirm')}</label>
                      <input
                        type="password" required
                        value={confirmVaultPin}
                        onChange={(e) => setConfirmVaultPin(e.target.value)}
                        className="terminal-input"
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    </div>
                    {vaultPin.length > 0 && vaultPin.length < 8 && (
                      <p className="text-[9px] text-neon-red">[!] {t('login.pinMin8')}</p>
                    )}
                  </div>
                </>
              ) : (
                /* ACCESS: только account-пароль на шаге 1 */
                <div className="space-y-2">
                  <label className="terminal-label">{t('login.accountPasswordLabel')}</label>
                  <p className="text-[8px] text-zinc-600">
                    Пароль учётки — вводишь на любом устройстве.
                  </p>
                  <input
                    type="password" required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="terminal-input"
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                </div>
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
                <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                  {mode === 'ACCESS' ? '[ ДАЛЕЕ →  ]' : (isBusy ? '...' : t('login.register'))}
                </TerminalGlitchButton>

                <button type="button"
                  onClick={() => { setMode(mode === 'ACCESS' ? 'GENESIS' : 'ACCESS'); resetForm() }}
                  className="text-[9px] uppercase tracking-widest text-zinc-600 hover:text-neon-cyan transition-colors">
                  {mode === 'ACCESS' ? t('login.newDevice') : t('login.existingVault')}
                </button>
              </div>

              {mode === 'ACCESS' && (
                <div className="mt-6 border-t border-neutral-900 pt-6 space-y-3">
                  <button type="button" onClick={handleVaultImport}
                    className="w-full border border-neutral-800 bg-zinc-950 py-2 text-[9px] uppercase tracking-widest text-zinc-500 hover:border-neon-cyan hover:text-neon-cyan transition-all">
                    {t('login.vaultRecoveryImport')}
                  </button>
                  {vaultLinkOk && (
                    <p className="mt-2 text-[8px] text-neon-cyan animate-pulse">{t('login.vaultRecoveryOk')}</p>
                  )}
                  <button type="button"
                    onClick={async () => { await clearSessionApi().catch(() => {}); window.location.reload() }}
                    className="w-full text-[8px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400 transition-colors">
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

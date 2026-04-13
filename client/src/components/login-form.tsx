'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/components/auth/auth-provider'
import { cryptoLogin, finalizeLoginWithTotp } from '@/lib/auth/crypto-login'
import { ensureClientDeviceId } from '@/lib/api/auth'
import { parseNickname } from '@/lib/nickname'
import {
  persistVaultBlobByLoginUsername,
  type VaultBlob,
} from '@/lib/vault'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'

export function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()

  const [handle, setHandle] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')

  const [mode, setMode] = useState<'ACCESS' | 'GENESIS'>('ACCESS')
  const [stage, setStage] = useState<'IDENTITY' | 'MFA_SYNC'>('IDENTITY')

  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [vaultLinkOk, setVaultLinkOk] = useState(false)

  const lock = useRef(false)

  useEffect(() => {
    ensureClientDeviceId()
  }, [])

  useEffect(() => {
    if (!authLoading && user) {
      const params = new URLSearchParams(window.location.search)
      const inviteCode = params.get('code')?.trim()
      router.replace(inviteCode ? `/join/${encodeURIComponent(inviteCode)}` : '/')
    }
  }, [authLoading, user, router])

  const mapFault = (code: string): string => {
    const registry: Record<string, string> = {
      USERNAME_REQUIRED: t('login.usernameRequired'),
      PASSWORD_REQUIRED: t('login.passwordRequired'),
      PIN_MIN_8: t('login.pinMin8'),
      NO_LOCAL_VAULT: t('login.noLocalVault'),
      VAULT_ALREADY_EXISTS: t('login.vaultExists'),
      UNWRAP_FAILED: t('login.unwrapFailed'),
      INVALID_VAULT_FORMAT: t('login.invalidVaultFormat'),
      VAULT_VERSION_MISMATCH: t('login.vaultVersionMismatch'),
      TOTP_INVALID: t('login.totpInvalid'),
      DEVICE_REVOKED: t('login.deviceRevoked'),
    }
    return registry[code] ?? code.replace(/_/g, ' ')
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
    setIsBusy(true)

    try {
      if (mode === 'GENESIS' && pin !== confirmPin) {
        setErrorLog(t('login.passwordMismatch'))
        return
      }

      const res = await cryptoLogin({
        username: handle,
        password: pin,
        mode: mode === 'ACCESS' ? 'login' : 'register'
      })

      if (res.ok === 'needs_2fa') {
        setPendingToken(res.pendingToken)
        setStage('MFA_SYNC')
        return
      }

      if (!res.ok) {
        setErrorLog(mapFault(res.error))
        return
      }

      await refresh()
      router.refresh()
    } catch (err: any) {
      setErrorLog(err.message || 'SYS_FAULT')
    } finally {
      setIsBusy(false)
      lock.current = false
    }
  }

  const execMfaSync = async (e: React.FormEvent) => {
    e.preventDefault()
    if (lock.current || isBusy || !pendingToken) return
    const digits = totpCode.replace(/\D/g, '').slice(0, 6)

    lock.current = true
    setErrorLog(null)
    setIsBusy(true)

    try {
      const r = await finalizeLoginWithTotp({
        pendingToken,
        code: digits,
        canonicalHandle: handle.trim(),
      })
      if (!r.ok) {
        setErrorLog(mapFault(r.error))
        return
      }
      await refresh()
      router.refresh()
    } catch (err: any) {
      setErrorLog(err.message || 'MFA_FAULT')
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
    <AnimatePresence mode="wait">
      {stage === 'MFA_SYNC' ? (
        <motion.form
          key="mfa"
          onSubmit={execMfaSync}
          className="relative w-full max-w-sm border border-neutral-900 bg-black p-8 shadow-2xl"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <header className="mb-8 border-b border-neutral-900 pb-4">
            <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">{t('login.totpTitle')}</p>
          </header>

          <div className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="totp" className="text-[9px] uppercase tracking-widest text-zinc-500">{t('login.totpCodeLabel')}</label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-zinc-950 border border-neutral-900 p-3 font-mono text-xl tracking-[0.6em] text-neon-cyan text-center outline-none focus:border-neon-cyan/50"
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>

            <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
              {t('login.totpSubmit')}
            </TerminalGlitchButton>

            <button
              type="button"
              onClick={() => setStage('IDENTITY')}
              className="w-full text-[9px] uppercase tracking-widest text-zinc-700 hover:text-neon-red"
            >
              {t('common.back')}
            </button>
          </div>
        </motion.form>
      ) : (
        <motion.form
          key="identity"
          onSubmit={execAuthProtocol}
          className={`relative w-full border border-neutral-900 bg-black p-8 shadow-2xl transition-all duration-500 ${mode === 'GENESIS' ? 'max-w-xl' : 'max-w-sm'}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

          <header className="mb-8 border-b border-neutral-900 pb-4">
            <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
              {mode === 'ACCESS' ? t('login.signIn') : t('login.register')}
            </p>
            <p className="mt-1 text-[8px] text-zinc-600 tracking-widest">E2E // ECDSA P-256 // ZERO-TRUST</p>
          </header>

          <div className="space-y-6">
            {mode === 'GENESIS' && (
              <div className="mb-6 border border-zinc-900 bg-zinc-950/50 p-4">
                <p className="text-[8px] uppercase tracking-widest text-neon-red mb-2">{t('login.tosRegisterTitle')}</p>
                <div className="max-h-32 overflow-y-auto text-[9px] leading-relaxed text-zinc-500 pr-2 custom-scrollbar">
                  {t('login.tosRegisterBody')}
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[9px] uppercase tracking-widest text-zinc-500">{t('login.handleLabel')}</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="w-full bg-zinc-950 border border-neutral-900 p-2.5 font-mono text-xs text-white outline-none focus:border-neon-cyan/50"
                  placeholder={t('login.handlePlaceholder')}
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[9px] uppercase tracking-widest text-zinc-500">{t('login.vaultPassphraseLabel')}</label>
                <input
                  type="password"
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="w-full bg-zinc-950 border border-neutral-900 p-2.5 font-mono text-xs text-white outline-none focus:border-neon-red/50"
                  placeholder="••••••••"
                  autoComplete={mode === 'ACCESS' ? 'current-password' : 'new-password'}
                />
              </div>

              {mode === 'GENESIS' && (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                  <label className="text-[9px] uppercase tracking-widest text-zinc-500">{t('common.confirm')}</label>
                  <input
                    type="password"
                    required
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value)}
                    className="w-full bg-zinc-950 border border-neutral-900 p-2.5 font-mono text-xs text-white outline-none focus:border-neon-red/50"
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </div>
              )}
            </div>

            {mode === 'GENESIS' && (
              <div className="border-l-2 border-neon-red bg-neon-red/5 p-3 text-[9px] leading-relaxed text-zinc-400 uppercase tracking-tighter">
                <span className="text-neon-red font-bold">WARNING:</span> {t('login.pinMin8')}
              </div>
            )}

            {errorLog && (
              <div className="border border-neon-red/50 bg-neon-red/5 p-2 text-[9px] text-neon-red font-mono">
                {errorLog}
              </div>
            )}

            <div className="flex flex-col gap-4 pt-4">
              <TerminalGlitchButton type="submit" disabled={isBusy} className="w-full">
                {mode === 'ACCESS' ? t('login.signIn') : t('login.register')}
              </TerminalGlitchButton>

              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'ACCESS' ? 'GENESIS' : 'ACCESS')
                  setErrorLog(null)
                }}
                className="text-[9px] uppercase tracking-widest text-zinc-600 hover:text-neon-cyan transition-colors"
              >
                {mode === 'ACCESS' ? t('login.newDevice') : t('login.existingVault')}
              </button>
            </div>

            {mode === 'ACCESS' && (
              <div className="mt-6 border-t border-neutral-900 pt-6">
                <button
                  type="button"
                  onClick={handleVaultImport}
                  className="w-full border border-neutral-800 bg-zinc-950 py-2 text-[9px] uppercase tracking-widest text-zinc-500 hover:border-neon-cyan hover:text-neon-cyan transition-all"
                >
                  {t('login.vaultRecoveryImport')}
                </button>
                {vaultLinkOk && <p className="mt-2 text-[8px] text-neon-cyan animate-pulse">{t('login.vaultRecoveryOk')}</p>}
              </div>
            )}
          </div>
        </motion.form>
      )}
    </AnimatePresence>
  )
}

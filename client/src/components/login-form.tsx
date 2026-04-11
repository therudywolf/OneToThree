'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [vaultImportOk, setVaultImportOk] = useState(false)
  const submitLock = useRef(false)

  useEffect(() => {
    ensureClientDeviceId()
  }, [])

  useEffect(() => {
    if (!authLoading && user) {
      if (typeof window === 'undefined') {
        router.replace('/')
        return
      }
      const code = new URLSearchParams(window.location.search)
        .get('code')
        ?.trim()
      if (code) {
        router.replace(`/join/${encodeURIComponent(code)}`)
      } else {
        router.replace('/')
      }
    }
  }, [authLoading, user, router])

  function mapError(code: string): string {
    const m: Record<string, string> = {
      USERNAME_REQUIRED: t('login.usernameRequired'),
      PASSWORD_REQUIRED: t('login.passwordRequired'),
      PIN_MIN_8: t('login.pinMin8'),
      NO_LOCAL_VAULT: t('login.noLocalVault'),
      VAULT_ALREADY_EXISTS: t('login.vaultExists'),
      UNWRAP_FAILED: t('login.unwrapFailed'),
      INVALID_VAULT_FORMAT: t('login.invalidVaultFormat'),
      LEGACY_VAULT_REQUIRES_REREGISTER: t('login.legacyVault'),
      INVALID_SIGNING_KEY: t('login.invalidSigningKey'),
      SIGN_FAILED: t('login.signFailed'),
      CHALLENGE_FAILED: t('login.challengeFailed'),
      VERIFY_FAILED: t('login.verifyFailed'),
      UNAUTHORIZED: t('login.unauthorized'),
      NO_CHALLENGE: t('login.noChallenge'),
      NONCE_MISMATCH: t('login.nonceMismatch'),
      SIGNATURE_INVALID: t('login.signatureInvalid'),
      PUBLIC_KEY_REQUIRED: t('login.publicKeyRequired'),
      PUBLIC_KEY_CONFLICT: t('login.publicKeyConflict'),
      USERNAME_TAKEN: t('login.usernameTaken'),
      INVALID_BODY: t('login.invalidBody'),
      INVALID_USERNAME_FORMAT: t('login.invalidUsernameFormat'),
      USERNAME_RESERVED: t('login.usernameReserved'),
      TOTP_INVALID: t('login.totpInvalid'),
      INVALID_PENDING_TOKEN: t('login.totpPendingInvalid'),
      TOTP_VERIFY_FAILED: t('login.totpVerifyFailed'),
      CLIENT_DEVICE_ID_REQUIRED: t('login.clientDeviceRequired'),
      DEVICE_REVOKED: t('login.deviceRevoked'),
    }
    return m[code] ?? code.replace(/_/g, ' ')
  }

  function handlePreLoginVaultImport() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.key,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setError(null)
      setVaultImportOk(false)
      try {
        const text = await file.text()
        const data = JSON.parse(text) as {
          userId?: string
          username?: string
          vault?: VaultBlob
        }
        if (
          !data.vault?.saltB64 ||
          !data.vault?.ivB64 ||
          !data.vault?.ciphertextB64
        ) {
          setError(t('settings.invalidVaultFile'))
          return
        }
        const fromFile =
          typeof data.username === 'string' ? data.username.trim() : ''
        const fromForm = username.trim()
        let nick = fromFile
          ? parseNickname(fromFile)
          : ({ ok: false, error: 'INVALID_USERNAME_FORMAT' } as const)
        if (!nick.ok && fromForm) {
          nick = parseNickname(fromForm)
        }
        if (!nick.ok) {
          if (!fromFile && !fromForm) {
            setError(t('login.vaultImportHandleMissing'))
          } else {
            setError(mapError(nick.error))
          }
          return
        }
        persistVaultBlobByLoginUsername(nick.value, data.vault)
        setUsername(nick.value)
        setVaultImportOk(true)
      } catch {
        setError(t('settings.importFailed'))
      }
    }
    input.click()
  }

  function resetTotpStep() {
    setStep('credentials')
    setPendingToken(null)
    setTotpCode('')
  }

  async function handleSubmitCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (submitLock.current || busy) return
    submitLock.current = true
    setError(null)
    setBusy(true)
    try {
      const result = await cryptoLogin({ username, password, mode })
      if (result.ok === 'needs_2fa') {
        setPendingToken(result.pendingToken)
        setStep('totp')
        return
      }
      if (!result.ok) {
        setError(mapError(result.error))
        return
      }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'UNKNOWN_ERROR')
    } finally {
      setBusy(false)
      submitLock.current = false
    }
  }

  async function handleSubmitTotp(e: React.FormEvent) {
    e.preventDefault()
    if (submitLock.current || busy || !pendingToken) return
    const digits = totpCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length !== 6) {
      setError(t('login.totpSixDigits'))
      return
    }
    submitLock.current = true
    setError(null)
    setBusy(true)
    try {
      const r = await finalizeLoginWithTotp({
        pendingToken,
        code: digits,
        canonicalHandle: username.trim(),
      })
      if (!r.ok) {
        setError(mapError(r.error))
        return
      }
      await refresh()
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'UNKNOWN_ERROR')
    } finally {
      setBusy(false)
      submitLock.current = false
    }
  }

  if (authLoading) {
    return (
      <div className="terminal-panel mx-auto max-w-md p-6 font-mono text-xs text-neon-cyan">
        {t('login.authLoading')}
      </div>
    )
  }
  if (user) {
    return null
  }

  if (step === 'totp') {
    return (
      <motion.form
        onSubmit={(ev: React.FormEvent<HTMLFormElement>) =>
          void handleSubmitTotp(ev)
        }
        className="terminal-panel mx-auto max-w-md space-y-6"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <div className="space-y-1 border-b border-neon-red/40 pb-4">
          <p className="text-xs text-neon-cyan">[AUTH] :: {t('login.totpTitle')}</p>
          <p className="text-[10px] uppercase tracking-[0.3em] text-red-700">
            {t('login.totpSubtitle')}
          </p>
        </div>
        <div>
          <label htmlFor="totp" className="terminal-label">
            &gt; {t('login.totpCodeLabel')}
          </label>
          <input
            id="totp"
            name="totp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={(e) =>
              setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
            }
            className="terminal-input tracking-[0.5em]"
            placeholder="000000"
            aria-label={t('login.totpCodeLabel')}
          />
        </div>
        {error ? (
          <p className="border border-neon-red bg-black px-2 py-1 font-mono text-xs text-neon-red">
            [!] {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TerminalGlitchButton type="submit" disabled={busy}>
            [ {t('login.totpSubmit')} ]
          </TerminalGlitchButton>
          <button
            type="button"
            onClick={() => {
              resetTotpStep()
              setError(null)
            }}
            className="rounded-none border border-transparent px-2 py-1 text-left font-mono text-xs uppercase tracking-widest text-neon-cyan underline-offset-4 hover:text-neon-red hover:underline"
          >
            :: {t('login.totpBack')}
          </button>
        </div>
      </motion.form>
    )
  }

  return (
    <motion.form
      onSubmit={(ev: React.FormEvent<HTMLFormElement>) =>
        void handleSubmitCredentials(ev)
      }
      className={`terminal-panel mx-auto space-y-6 ${
        mode === 'register' ? 'max-w-2xl' : 'max-w-md'
      }`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="space-y-1 border-b border-neon-red/40 pb-4">
        <p className="text-xs text-neon-cyan">[AUTH] CHALLENGE–RESPONSE</p>
        <p className="text-[10px] uppercase tracking-[0.3em] text-red-700">
          ECDSA P-256 · KEYS STAY ON DEVICE
        </p>
      </div>

      {mode === 'register' ? (
        <section
          className="border border-neon-cyan/30 bg-black/60"
          aria-labelledby="tos-register-heading"
        >
          <h2
            id="tos-register-heading"
            className="border-b border-neon-cyan/25 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.25em] text-neon-red"
          >
            {t('login.tosRegisterTitle')}
          </h2>
          <div className="max-h-[min(52vh,30rem)] overflow-y-auto px-3 py-3 font-mono text-[10px] leading-relaxed text-red-800/95">
            {t('login.tosRegisterBody')
              .split('\n\n')
              .map((para, i) => (
                <p key={i} className="mb-3 last:mb-0">
                  {para}
                </p>
              ))}
          </div>
        </section>
      ) : null}

      <div>
        <label htmlFor="username" className="terminal-label">
          &gt; {t('login.handleLabel')}
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="terminal-input"
          placeholder={t('login.handlePlaceholder')}
        />
      </div>

      <div>
        <label htmlFor="password" className="terminal-label">
          &gt; {t('login.vaultPassphraseLabel')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={
            mode === 'login' ? 'current-password' : 'new-password'
          }
          required
          minLength={mode === 'register' ? 8 : 1}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="terminal-input"
          placeholder="••••••••"
        />
      </div>

      {error ? (
        <p className="border border-neon-red bg-black px-2 py-1 font-mono text-xs text-neon-red">
          [!] {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TerminalGlitchButton type="submit" disabled={busy}>
          {mode === 'login' ? '[ LOGIN ]' : '[ REGISTER ]'}
        </TerminalGlitchButton>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError(null)
            resetTotpStep()
          }}
          className="rounded-none border border-transparent px-2 py-1 text-left font-mono text-xs uppercase tracking-widest text-neon-cyan underline-offset-4 hover:text-neon-red hover:underline"
        >
          {mode === 'login'
            ? `:: ${t('login.newDevice')}`
            : `:: ${t('login.existingVault')}`}
        </button>
      </div>

      {mode === 'login' ? (
        <div className="border-t border-zinc-800 pt-4">
          <p className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            {t('login.vaultRecoveryTitle')}
          </p>
          <button
            type="button"
            onClick={handlePreLoginVaultImport}
            className="w-full border border-zinc-700 bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-zinc-400 hover:border-neon-cyan/50 hover:text-neon-cyan"
          >
            [ {t('login.vaultRecoveryImport')} ]
          </button>
          {vaultImportOk ? (
            <p className="mt-2 font-mono text-[10px] text-neon-cyan">
              :: {t('login.vaultRecoveryOk')}
            </p>
          ) : null}
        </div>
      ) : null}
    </motion.form>
  )
}

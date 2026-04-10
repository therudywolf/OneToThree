'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { useAuth } from '@/components/auth/auth-provider'
import { cryptoLogin } from '@/lib/auth/crypto-login'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'

export function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!authLoading && user) {
      router.replace('/')
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
    }
    return m[code] ?? code.replace(/_/g, ' ')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await cryptoLogin({ username, password, mode })
      if (!result.ok) {
        setError(mapError(result.error))
        return
      }
      await refresh()
      router.push('/')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'UNKNOWN_ERROR')
    } finally {
      setBusy(false)
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

  return (
    <motion.form
      onSubmit={(ev: React.FormEvent<HTMLFormElement>) => void handleSubmit(ev)}
      className="terminal-panel mx-auto max-w-md space-y-6"
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
          }}
          className="rounded-none border border-transparent px-2 py-1 text-left font-mono text-xs uppercase tracking-widest text-neon-cyan underline-offset-4 hover:text-neon-red hover:underline"
        >
          {mode === 'login'
            ? `:: ${t('login.newDevice')}`
            : `:: ${t('login.existingVault')}`}
        </button>
      </div>
    </motion.form>
  )
}

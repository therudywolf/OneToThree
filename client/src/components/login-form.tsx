'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { useAuth } from '@/components/auth/auth-provider'
import { cryptoLogin } from '@/lib/auth/crypto-login'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

function mapError(code: string): string {
  const m: Record<string, string> = {
    USERNAME_REQUIRED: 'Username is required.',
    PASSWORD_REQUIRED: 'Passphrase is required.',
    PIN_MIN_8: 'Passphrase must be at least 8 characters for new keys.',
    NO_LOCAL_VAULT:
      'No local vault for this handle. Register on this device first.',
    VAULT_ALREADY_EXISTS: 'A vault already exists for this handle. Use login.',
    UNWRAP_FAILED: 'Wrong passphrase or corrupted vault.',
    INVALID_VAULT_FORMAT: 'Vault data is invalid.',
    LEGACY_VAULT_REQUIRES_REREGISTER:
      'This vault predates ECDSA auth. Register a new handle or clear local data.',
    INVALID_SIGNING_KEY: 'Could not load signing key from vault.',
    SIGN_FAILED: 'Signing the challenge failed.',
    CHALLENGE_FAILED: 'Could not reach auth server.',
    VERIFY_FAILED: 'Verification failed.',
    UNAUTHORIZED: 'Session invalid.',
    NO_CHALLENGE: 'No active challenge — try again.',
    NONCE_MISMATCH: 'Challenge mismatch — try again.',
    SIGNATURE_INVALID: 'Signature rejected by server.',
    PUBLIC_KEY_REQUIRED: 'Server expected a public key (registration).',
    PUBLIC_KEY_CONFLICT: 'Public key does not match server record.',
    USERNAME_TAKEN: 'That handle is already taken.',
    INVALID_BODY: 'Invalid request.',
  }
  return m[code] ?? code.replace(/_/g, ' ')
}

export function LoginForm() {
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
        CHECKING_SESSION…
      </div>
    )
  }
  if (user) {
    return null
  }

  return (
    <motion.form
      onSubmit={(ev) => void handleSubmit(ev)}
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
          &gt; HANDLE
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
          placeholder="operator"
        />
      </div>

      <div>
        <label htmlFor="password" className="terminal-label">
          &gt; VAULT_PASSPHRASE
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
          {mode === 'login' ? ':: NEW_DEVICE' : ':: EXISTING_VAULT'}
        </button>
      </div>
    </motion.form>
  )
}

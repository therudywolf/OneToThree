'use client'

import { useState } from 'react'
import {
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import {
  persistVaultBlob,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Mode = 'unlock' | 'setup'

type Props = {
  userId: string
  email: string
  mode: Mode
}

export function VaultModal({ userId, email, mode }: Props) {
  const setUnwrappedPrivateKey = useChatStore((s) => s.setUnwrappedPrivateKey)

  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [username, setUsername] = useState(
    email.includes('@') ? email.split('@')[0] : 'operator'
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const blob = readVaultBlob(userId)
      if (!blob) {
        setError('NO_LOCAL_VAULT')
        return
      }
      const jwk = await unwrapPrivateJwkWithPin(blob, pin)
      const key = await importEcdhPrivateKey(jwk)
      setUnwrappedPrivateKey(key)
      setPin('')
    } catch {
      setError('UNWRAP_FAILED')
    } finally {
      setBusy(false)
    }
  }

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (pin.length < 8) {
      setError('PIN_MIN_8')
      return
    }
    if (pin !== pin2) {
      setError('PIN_MISMATCH')
      return
    }
    if (!username.trim()) {
      setError('USERNAME_REQUIRED')
      return
    }
    setBusy(true)
    try {
      const pair = await generateKeyPair({ curve: 'P-256' })
      const pubJwk = await exportPublicKey(pair.publicKey)
      const privJwk = await exportPrivateKey(pair.privateKey)
      const blob = await wrapPrivateJwkWithPin(privJwk, pin)
      persistVaultBlob(userId, blob)

      const key = await importEcdhPrivateKey(privJwk)
      setUnwrappedPrivateKey(key)
      setPin('')
      setPin2('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'SETUP_FAIL'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Key vault"
    >
      <div className="terminal-panel w-full max-w-md space-y-6">
        <header className="border-b border-neon-red/40 pb-3">
          <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ VAULT ] :: {mode === 'setup' ? 'INIT_KEYRING' : 'UNLOCK_SESSION'}
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">{email}</p>
          <p className="mt-1 font-mono text-[10px] text-red-700">
            PIN EXISTS ONLY IN RAM — NEVER LOGGED OR PERSISTED
          </p>
        </header>

        {mode === 'unlock' ? (
          <form onSubmit={handleUnlock} className="space-y-4">
            <div>
              <label className="terminal-label" htmlFor="vault-pin">
                &gt; VAULT_PIN
              </label>
              <input
                id="vault-pin"
                type="password"
                autoComplete="off"
                className="terminal-input"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required
              />
            </div>
            {error ? (
              <p className="border border-neon-red px-2 py-1 font-mono text-xs text-neon-red">
                [!] {error}
              </p>
            ) : null}
            <TerminalGlitchButton type="submit" disabled={busy}>
              [ UNLOCK ]
            </TerminalGlitchButton>
          </form>
        ) : (
          <form onSubmit={handleSetup} className="space-y-4">
            <div>
              <label className="terminal-label" htmlFor="handle">
                &gt; HANDLE
              </label>
              <input
                id="handle"
                className="terminal-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="terminal-label" htmlFor="pin-a">
                &gt; VAULT_PIN
              </label>
              <input
                id="pin-a"
                type="password"
                autoComplete="new-password"
                className="terminal-input"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="terminal-label" htmlFor="pin-b">
                &gt; CONFIRM_PIN
              </label>
              <input
                id="pin-b"
                type="password"
                autoComplete="new-password"
                className="terminal-input"
                value={pin2}
                onChange={(e) => setPin2(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error ? (
              <p className="border border-neon-red px-2 py-1 font-mono text-xs text-neon-red">
                [!] {error}
              </p>
            ) : null}
            <TerminalGlitchButton type="submit" disabled={busy}>
              [ SEAL_KEYS ]
            </TerminalGlitchButton>
          </form>
        )}
      </div>
    </div>
  )
}

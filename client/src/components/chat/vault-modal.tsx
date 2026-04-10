'use client'

import { useState } from 'react'
import { importEcdhPrivateKey } from '@/lib/crypto'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import {
  readVaultBlob,
  unwrapPrivateJwkWithPin,
} from '@/lib/vault'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = {
  userId: string
  displayHandle: string
}

export function VaultModal({ userId, displayHandle }: Props) {
  const setUnwrappedPrivateKey = useChatStore((s) => s.setUnwrappedPrivateKey)

  const [pin, setPin] = useState('')
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
      const plain = await unwrapPrivateJwkWithPin(blob, pin)
      const parsed = parseVaultPlaintext(plain)
      if (!parsed) {
        setError('INVALID_VAULT_FORMAT')
        return
      }
      if (parsed.kind === 'legacy_ecdh') {
        const key = await importEcdhPrivateKey(parsed.ecdhPrivateJwkString)
        setUnwrappedPrivateKey(key)
        setPin('')
        return
      }
      const key = await importEcdhPrivateKey(parsed.ecdhPrivateJwk)
      setUnwrappedPrivateKey(key)
      setPin('')
    } catch {
      setError('UNWRAP_FAILED')
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
            [ VAULT ] :: UNLOCK_SESSION
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">{displayHandle}</p>
          <p className="mt-1 font-mono text-[10px] text-red-700">
            PIN EXISTS ONLY IN RAM — NEVER LOGGED OR PERSISTED
          </p>
        </header>

        <form onSubmit={(ev) => void handleUnlock(ev)} className="space-y-4">
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
      </div>
    </div>
  )
}

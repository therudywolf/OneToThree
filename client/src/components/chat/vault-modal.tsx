'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import {
  readVaultBlob,
  unwrapPrivateJwkWithPin,
} from '@/lib/vault'
import {
  enrollWebAuthnVaultUnlock,
  hasWebAuthnVaultMeta,
  largeBlobLikelySupported,
  unlockVaultWithWebAuthn,
} from '@/lib/webauthn-vault'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { vibrateShort } from '@/lib/vibrate'

type Props = {
  userId: string
  displayHandle: string
}

export function VaultModal({ userId, displayHandle }: Props) {
  const setUnwrappedPrivateKey = useChatStore((s) => s.setUnwrappedPrivateKey)

  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bioEnrolled, setBioEnrolled] = useState(false)

  useEffect(() => {
    void hasWebAuthnVaultMeta(userId).then(setBioEnrolled)
  }, [userId])

  const applyPlaintext = useCallback(
    async (plain: string) => {
      const parsed = parseVaultPlaintext(plain)
      if (!parsed) {
        setError('INVALID_VAULT_FORMAT')
        return
      }
      if (parsed.kind === 'legacy_ecdh') {
        const key = await importEcdhPrivateKey(parsed.ecdhPrivateJwkString)
        setUnwrappedPrivateKey(key)
        try {
          await patchMyEcdhPublicKey(
            exportEcdhPublicJwkFromPrivateKeyString(parsed.ecdhPrivateJwkString)
          )
        } catch {
          /* server may be offline */
        }
        setPin('')
        return
      }
      const key = await importEcdhPrivateKey(parsed.ecdhPrivateJwk)
      setUnwrappedPrivateKey(key)
      try {
        await patchMyEcdhPublicKey(
          exportEcdhPublicJwkFromPrivateKeyString(parsed.ecdhPrivateJwk)
        )
      } catch {
        /* non-fatal */
      }
      setPin('')
    },
    [setUnwrappedPrivateKey]
  )

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
      await applyPlaintext(plain)
      vibrateShort(20)
    } catch {
      setError('UNWRAP_FAILED')
    } finally {
      setBusy(false)
    }
  }

  async function handleBiometricUnlock() {
    setError(null)
    setBusy(true)
    try {
      const plain = await unlockVaultWithWebAuthn(userId)
      await applyPlaintext(plain)
      vibrateShort(25)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'WEBAUTHN_FAILED')
    } finally {
      setBusy(false)
    }
  }

  async function handleEnrollBiometrics() {
    setError(null)
    if (!pin.trim()) {
      setError('PIN_REQUIRED_FOR_SETUP')
      return
    }
    setBusy(true)
    try {
      const r = await enrollWebAuthnVaultUnlock(userId, displayHandle, pin)
      if (!r.ok) {
        setError(r.error)
        return
      }
      await applyPlaintext(r.plaintext)
      setBioEnrolled(true)
      vibrateShort([15, 30, 15])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ENROLL_FAILED')
    } finally {
      setBusy(false)
    }
  }

  const showBioSetup =
    largeBlobLikelySupported() && !bioEnrolled && !busy

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Key vault"
    >
      <div className="terminal-panel w-full max-w-md space-y-6">
        <header className="border-b border-neon-red/40 pb-3">
          <p className="glitch-text text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ VAULT ] :: UNLOCK_SESSION
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">{displayHandle}</p>
          <p className="mt-1 font-mono text-[10px] text-red-700">
            PIN EXISTS ONLY IN RAM — NEVER LOGGED OR PERSISTED
          </p>
        </header>

        {bioEnrolled ? (
          <div className="space-y-4">
            <p className="font-mono text-[10px] text-neon-cyan/80">
              Biometric unlock is configured. Vault is bound to this device&apos;s
              passkey — your previous PIN no longer applies.
            </p>
            <TerminalGlitchButton
              type="button"
              disabled={busy}
              onClick={() => void handleBiometricUnlock()}
            >
              [ USE_BIOMETRICS ]
            </TerminalGlitchButton>
            {error ? (
              <p className="border border-neon-red px-2 py-1 font-mono text-xs text-neon-red">
                [!] {error}
              </p>
            ) : null}
          </div>
        ) : (
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
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <TerminalGlitchButton type="submit" disabled={busy}>
                [ UNLOCK ]
              </TerminalGlitchButton>
              {showBioSetup && !bioEnrolled ? (
                <TerminalGlitchButton
                  type="button"
                  disabled={busy || !pin.trim()}
                  onClick={() => void handleEnrollBiometrics()}
                  className="border-neon-red/80 text-neon-red"
                >
                  [ CONFIGURE_BIOMETRICS ]
                </TerminalGlitchButton>
              ) : null}
            </div>
            {!largeBlobLikelySupported() ? (
              <p className="font-mono text-[9px] text-red-800">
                Biometric vault requires HTTPS and a browser with WebAuthn largeBlob
                (e.g. Chromium).
              </p>
            ) : null}
          </form>
        )}
      </div>
    </div>
  )
}

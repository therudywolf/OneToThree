'use client'

import { useCallback, useEffect, useState } from 'react'
// [BIO_DISABLED] import { Fingerprint, ScanFace } from 'lucide-react'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import {
  CURRENT_VAULT_VERSION,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  VaultVersionMismatchError,
} from '@/lib/vault'
// [BIO_DISABLED]
// import {
//   enrollWebAuthnVaultUnlock,
//   hasWebAuthnVaultMeta,
//   largeBlobLikelySupported,
//   unlockVaultWithWebAuthn,
// } from '@/lib/webauthn-vault'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { vibrateShort } from '@/lib/vibrate'
import { useTranslation } from '@/hooks/use-translation'
// [BIO_DISABLED] import { isIOSOrIPadOS } from '@/lib/ios'

// [BIO_DISABLED] Biometric icon hook — kept for future re-enable
// function useBiometricIcon() {
//   const [isApple, setIsApple] = useState(false)
//   useEffect(() => {
//     setIsApple(isIOSOrIPadOS())
//   }, [])
//   return isApple ? ScanFace : Fingerprint
// }

type Props = {
  userId: string
  displayHandle: string
}

export function VaultModal({ userId, displayHandle }: Props) {
  const { t } = useTranslation()
  const setUnwrappedPrivateKey = useChatStore((s) => s.setUnwrappedPrivateKey)
  // [BIO_DISABLED] const BiometricIcon = useBiometricIcon()

  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // [BIO_DISABLED] biometric enrollment state
  // const [bioEnrolled, setBioEnrolled] = useState(false)
  // const [showPinFallback, setShowPinFallback] = useState(false)

  // [BIO_DISABLED] biometric meta check
  // useEffect(() => {
  //   void hasWebAuthnVaultMeta(userId).then(setBioEnrolled)
  // }, [userId])

  // suppress unused warning while bio is disabled
  void useEffect

  const applyPlaintext = useCallback(
    async (plain: string) => {
      const parsed = parseVaultPlaintext(plain)
      if (!parsed) {
        setError(t('login.invalidVaultFormat'))
        return
      }
      if (parsed.kind === 'LEGACY') {
        const key = await importEcdhPrivateKey(parsed.ecdhJwk)
        setUnwrappedPrivateKey(key)
        try {
          await patchMyEcdhPublicKey(
            exportEcdhPublicJwkFromPrivateKeyString(parsed.ecdhJwk)
          )
        } catch {
          /* server may be offline */
        }
        setPin('')
        return
      }
      const key = await importEcdhPrivateKey(parsed.ecdhJwk)
      setUnwrappedPrivateKey(key)
      try {
        await patchMyEcdhPublicKey(
          exportEcdhPublicJwkFromPrivateKeyString(parsed.ecdhJwk)
        )
      } catch {
        /* non-fatal */
      }
      setPin('')
    },
    [setUnwrappedPrivateKey, t]
  )

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const blob = readVaultBlob(userId)
      if (!blob) {
        setError(t('login.noLocalVault'))
        return
      }
      if (blob.version > CURRENT_VAULT_VERSION) {
        throw new VaultVersionMismatchError()
      }
      const plain = await unwrapPrivateJwkWithPin(blob, pin)
      await applyPlaintext(plain)
      vibrateShort(20)
    } catch (err) {
      if (err instanceof VaultVersionMismatchError) {
        setError(t('login.vaultVersionMismatch'))
      } else {
        setError(t('login.unwrapFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  // [BIO_DISABLED] biometric unlock handlers — kept for future re-enable
  // async function handleBiometricUnlock() {
  //   setError(null)
  //   setBusy(true)
  //   try {
  //     const plain = await unlockVaultWithWebAuthn(userId)
  //     await applyPlaintext(plain)
  //     vibrateShort(25)
  //   } catch (e) {
  //     setError(e instanceof Error ? e.message : t('errors.generic'))
  //   } finally {
  //     setBusy(false)
  //   }
  // }

  // async function handleEnrollBiometrics() {
  //   setError(null)
  //   if (!pin.trim()) {
  //     setError(t('login.passwordRequired'))
  //     return
  //   }
  //   setBusy(true)
  //   try {
  //     const r = await enrollWebAuthnVaultUnlock(userId, displayHandle, pin)
  //     if (!r.ok) {
  //       setError(r.error)
  //       return
  //     }
  //     await applyPlaintext(r.plaintext)
  //     setBioEnrolled(true)
  //     vibrateShort([15, 30, 15])
  //   } catch (e) {
  //     setError(e instanceof Error ? e.message : t('errors.generic'))
  //   } finally {
  //     setBusy(false)
  //   }
  // }

  // [BIO_DISABLED] const showBioSetup = largeBlobLikelySupported() && !bioEnrolled && !busy

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 px-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={t('login.vaultPassphraseLabel')}
    >
      <div className="w-full max-w-sm space-y-6 border border-neon-cyan/40 bg-black p-6 shadow-[0_0_30px_rgba(0,255,255,0.05)]">
        <header className="border-b border-neon-cyan/30 pb-4">
          <p className="font-mono text-sm uppercase tracking-[0.35em] text-neon-cyan animate-pulse">
            {t('login.vaultPassphraseLabel')}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
            {displayHandle}
          </p>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-red-900">
            E2E // {t('login.pinMin8')}
          </p>
        </header>

        {/* [BIO_DISABLED] biometric unlock screen — re-enable when bio flow is restored
        {bioEnrolled && !showPinFallback ? (
          <div className="space-y-5">
            ...biometric UI...
          </div>
        ) : ( */}
        <form onSubmit={(ev) => void handleUnlock(ev)} className="space-y-5">
          <div>
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-neon-cyan/70" htmlFor="vault-pin">
              {t('login.vaultPassphraseLabel')}
            </label>
            <input
              id="vault-pin"
              type="password"
              autoComplete="current-password"
              autoFocus
              className="w-full border border-neon-cyan/30 bg-black px-3 py-2 font-mono text-neon-cyan transition-colors focus:border-neon-cyan focus:bg-neon-cyan/5 focus:outline-none"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </div>
          {error ? (
            <p className="border-l-2 border-neon-red bg-red-950/20 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-3">
            <TerminalGlitchButton type="submit" disabled={busy} className="w-full">
              {t('login.signIn')}
            </TerminalGlitchButton>
            {/* [BIO_DISABLED] biometric fallback / enroll buttons
            {bioEnrolled && showPinFallback ? (
              <button ...biometric back button... />
            ) : null}
            {showBioSetup && !bioEnrolled ? (
              <button ...enroll biometrics button... />
            ) : null}
            */}
          </div>
        </form>
        {/* )} */}
      </div>
    </div>
  )
}

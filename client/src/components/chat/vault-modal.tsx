'use client'

import { useCallback, useEffect, useState } from 'react'
import { Fingerprint, ScanFace } from 'lucide-react'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import { deriveDrBundleFromEcdhJwk, deriveSessionWrapKey } from '@/lib/ratchet/identity-from-vault'
import { setOwnDrIdentity, setSessionWrapKey, encodeBase64Url } from '@/lib/ratchet/session-manager'
import { publishIdentity, publishSignedPrekey } from '@/lib/api/keys'
import {
  CURRENT_VAULT_VERSION,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  VaultVersionMismatchError,
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
import { useTranslation } from '@/hooks/use-translation'
import { isIOSOrIPadOS } from '@/lib/ios'

/** Detect if the device likely uses Face ID (iOS) vs fingerprint (Android/other) */
function useBiometricIcon() {
  const [isApple, setIsApple] = useState(false)
  useEffect(() => {
    setIsApple(isIOSOrIPadOS())
  }, [])
  return isApple ? ScanFace : Fingerprint
}

type Props = {
  userId: string
  displayHandle: string
}

export function VaultModal({ userId, displayHandle }: Props) {
  const { t } = useTranslation()
  const setUnwrappedPrivateKey = useChatStore((s) => s.setUnwrappedPrivateKey)
  const BiometricIcon = useBiometricIcon()

  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bioEnrolled, setBioEnrolled] = useState(false)
  const [showPinFallback, setShowPinFallback] = useState(false)

  useEffect(() => {
    void hasWebAuthnVaultMeta(userId).then(setBioEnrolled)
  }, [userId])

  const applyPlaintext = useCallback(
    async (plain: string) => {
      const parsed = parseVaultPlaintext(plain)
      if (!parsed) {
        setError(t('login.invalidVaultFormat'))
        return
      }
      const ecdhJwk = parsed.kind === 'V2' ? parsed.ecdhJwk : parsed.ecdhJwk
      const key = await importEcdhPrivateKey(ecdhJwk)
      setUnwrappedPrivateKey(key)

      // Upload ECDH public key so fan-out can find this device.
      try {
        await patchMyEcdhPublicKey(exportEcdhPublicJwkFromPrivateKeyString(ecdhJwk))
      } catch { /* non-fatal: server may be offline */ }

      // Derive DR identity from vault ECDH key and activate it in-memory.
      try {
        const bundle = deriveDrBundleFromEcdhJwk(ecdhJwk)
        const wrapKey = await deriveSessionWrapKey(bundle.identity)
        setSessionWrapKey(wrapKey)
        setOwnDrIdentity(bundle.identity, bundle.signedPreKey, bundle.signedPreKeyId)

        // Publish key bundle to server once per account (generation 1 = stable).
        // The server ignores duplicate publishes with the same generation.
        const publishedKey = `p13:dr-published:${userId}`
        if (!localStorage.getItem(publishedKey)) {
          await publishIdentity({
            signing_public_key: encodeBase64Url(bundle.identity.signing.publicKey),
            exchange_public_key: encodeBase64Url(bundle.identity.exchange.publicKey),
            generation: 1,
          })
          await publishSignedPrekey({
            pre_key_id: bundle.signedPreKeyId,
            public_key: encodeBase64Url(bundle.signedPreKey.publicKey),
            signature: encodeBase64Url(bundle.signedPreKeySignature),
          })
          localStorage.setItem(publishedKey, '1')
        }
      } catch { /* DR setup is non-fatal; v1 fanout still works */ }

      setPin('')
    },
    [setUnwrappedPrivateKey, t, userId]
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

  async function handleBiometricUnlock() {
    setError(null)
    setBusy(true)
    try {
      const plain = await unlockVaultWithWebAuthn(userId)
      await applyPlaintext(plain)
      vibrateShort(25)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  async function handleEnrollBiometrics() {
    setError(null)
    if (!pin.trim()) {
      setError(t('login.passwordRequired'))
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
      setError(e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  const showBioSetup =
    largeBlobLikelySupported() && !bioEnrolled && !busy

  // Suppress unused-var warnings while bio buttons are hidden from UI
  void BiometricIcon
  void bioEnrolled
  void showPinFallback
  void setShowPinFallback
  void handleBiometricUnlock
  void handleEnrollBiometrics
  void showBioSetup

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-void/95 px-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Key vault"
    >
      <div className="w-full max-w-sm space-y-6 border border-neon-cyan/40 bg-void p-6 shadow-[0_0_30px_rgba(0,255,255,0.05)]">
        <header className="border-b border-neon-cyan/30 pb-4">
          <p className="font-mono text-sm uppercase tracking-[0.35em] text-neon-cyan animate-pulse">
            {t('login.vaultPassphraseLabel')}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
            {displayHandle}
          </p>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-danger">
            E2E // {t('login.pinMin8')}
          </p>
        </header>

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
              className="w-full border border-neon-cyan/30 bg-void px-3 py-2 font-mono text-neon-cyan transition-colors focus:border-neon-cyan focus:bg-neon-cyan/5 focus:outline-none"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </div>
          {error ? (
            <p className="border-l-2 border-neon-red bg-danger/30 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red">
              {error}
            </p>
          ) : null}
          <TerminalGlitchButton type="submit" disabled={busy} aria-label="UNLOCK" className="w-full">
            {t('login.signIn')}
          </TerminalGlitchButton>
        </form>
      </div>
    </div>
  )
}

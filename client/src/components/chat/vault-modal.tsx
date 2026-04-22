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
  upgradeVaultBlob,
  persistVaultBlob,
  VaultVersionMismatchError,
} from '@/lib/vault'
import {
  enrollWebAuthnVaultUnlock,
  hasWebAuthnVaultMeta,
  largeBlobLikelySupported,
  unlockVaultWithWebAuthn,
} from '@/lib/webauthn-vault'
import { useSessionStore } from '@/store/sessionStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { vibrateShort } from '@/lib/vibrate'
import { useTranslation } from '@/hooks/use-translation'
import { isIOSOrIPadOS } from '@/lib/ios'
import { useThemeStore } from '@/store/themeStore'

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
  const setUnwrappedPrivateKey = useSessionStore((s) => s.setUnwrappedPrivateKey)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
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
      if (blob.version < CURRENT_VAULT_VERSION) {
        upgradeVaultBlob(blob, pin)
          .then((upgraded) => persistVaultBlob(userId, upgraded))
          .catch(() => { /* non-fatal — user stays on legacy vault */ })
      }
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
      className={`fixed inset-0 z-[200] flex items-center justify-center px-4 ${
        isMd3
          ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm'
          : 'bg-void/95 backdrop-blur-md'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Key vault"
    >
      <div className={`w-full max-w-sm space-y-6 p-6 ${
        isMd3
          ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
          : 'border border-neon-cyan/40 bg-void shadow-[0_0_30px_rgba(0,255,255,0.05)]'
      }`}>
        <header className={`pb-4 ${isMd3 ? 'border-b border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-b border-neon-cyan/30'}`}>
          <p className={`text-sm ${isMd3 ? 'font-medium tracking-normal text-[var(--on-surface)]' : 'font-mono uppercase tracking-[0.35em] text-neon-cyan animate-pulse'}`}>
            {t('login.vaultPassphraseLabel')}
          </p>
          <p className={`mt-2 text-[10px] ${isMd3 ? 'tracking-wide text-text-muted' : 'font-mono uppercase tracking-widest text-neon-cyan/60'}`}>
            {displayHandle}
          </p>
          <p className={`mt-1 text-[9px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-widest text-danger'}`}>
            E2E // {t('login.pinMin8')}
          </p>
        </header>

        <form onSubmit={(ev) => void handleUnlock(ev)} className="space-y-5">
          <div>
            <label className={`mb-2 block text-[10px] ${isMd3 ? 'tracking-wide text-text-muted' : 'font-mono uppercase tracking-widest text-neon-cyan/70'}`} htmlFor="vault-pin">
              {t('login.vaultPassphraseLabel')}
            </label>
            <input
              id="vault-pin"
              type="password"
              autoComplete="current-password"
              autoFocus
              className={`h-10 w-full px-3 transition-colors focus:outline-none ${
                isMd3
                  ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] placeholder:text-text-muted focus:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                  : 'border border-neon-cyan/30 bg-void font-mono text-neon-cyan focus:border-neon-cyan focus:bg-neon-cyan/5'
              }`}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </div>
          {error ? (
            <p className={`px-3 py-2 text-[10px] ${isMd3 ? 'rounded-2xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]' : 'border-l-2 border-neon-red bg-danger/30 font-mono uppercase tracking-widest text-neon-red'}`}>
              {error}
            </p>
          ) : null}
          {isMd3 ? (
            <button
              type="submit"
              disabled={busy}
              aria-label="UNLOCK"
              className="h-10 w-full rounded-full bg-[var(--neon-red)] px-4 text-[var(--surface)] shadow-[var(--md3-elevation-2)] transition-colors hover:brightness-110 disabled:opacity-50"
            >
              {t('login.signIn')}
            </button>
          ) : (
            <TerminalGlitchButton type="submit" disabled={busy} aria-label="UNLOCK" className="w-full">
              {t('login.signIn')}
            </TerminalGlitchButton>
          )}
        </form>
      </div>
    </div>
  )
}

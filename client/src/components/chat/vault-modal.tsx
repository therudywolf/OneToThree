'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import { Fingerprint, ScanFace } from 'lucide-react'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import { listEcdhPublicKeys, recordEcdhPublicKey } from '@/lib/ecdh-key-history'
import { purgeOutboxStaleForKey } from '@/lib/outbox'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import {
  deriveDrBundleFromEcdhJwk,
  deriveSessionWrapKey,
  deriveDeviceDrRoot,
  deriveOtpBatch,
  deriveOtpPrivKey,
} from '@/lib/ratchet/identity-from-vault'
import { setOwnDrIdentity, setSessionWrapKey, encodeBase64Url } from '@/lib/ratchet/session-manager'
import { getOrCreateClientDeviceId } from '@/lib/client-device'
import { publishIdentity, publishSignedPrekey, publishOneTimePrekeys, fetchInventory } from '@/lib/api/keys'
import {
  CURRENT_VAULT_VERSION,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  upgradeVaultBlob,
  persistVaultBlob,
  VaultVersionMismatchError,
} from '@/lib/vault'
import { runPostLoginVaultSync } from '@/lib/vault-sync'
import {
  enrollWebAuthnVaultUnlock,
  hasWebAuthnVaultMeta,
  largeBlobLikelySupported,
  unlockVaultWithWebAuthn,
} from '@/lib/webauthn-vault'
import {
  isKeychainAvailable,
  keychainGet,
  keychainSet,
} from '@/lib/native-keychain'
import { useSessionStore } from '@/store/sessionStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { vibrateShort } from '@/lib/vibrate'
import { useTranslation } from '@/hooks/use-translation'
import { isIOSOrIPadOS } from '@/lib/ios'
import { useThemeStore } from '@/store/themeStore'
import { LogoutButton } from '@/components/logout-button'

// OTP pool tracking is per (user, device) — each device owns its own OTP
// space in the device-scoped server key directory (track A4).
const OTP_NEXT_ID_KEY = (userId: string, deviceId: string) =>
  `p13:dr-otp-next:${userId}:${deviceId}`
const OTP_REPLENISH_THRESHOLD = 5
const OTP_BATCH_SIZE = 20

async function publishDrOtpBatch(
  userId: string,
  deviceId: string,
  dRoot: Uint8Array,
  startId: number,
  count: number
): Promise<void> {
  const batch = deriveOtpBatch(dRoot, startId, count)
  await publishOneTimePrekeys({
    keys: batch.map((k) => ({
      pre_key_id: k.id,
      public_key: encodeBase64Url(k.keypair.publicKey),
    })),
  })
  localStorage.setItem(OTP_NEXT_ID_KEY(userId, deviceId), String(startId + count))
}

async function replenishOtpsIfNeeded(
  userId: string,
  deviceId: string,
  dRoot: Uint8Array
): Promise<void> {
  try {
    const inventory = await fetchInventory()
    if (inventory.one_time_prekeys > OTP_REPLENISH_THRESHOLD) return
    // If pool is empty use id=1 (fresh start); otherwise continue from where we left off.
    const nextIdRaw = localStorage.getItem(OTP_NEXT_ID_KEY(userId, deviceId))
    const nextId = nextIdRaw ? parseInt(nextIdRaw, 10) : 1
    if (!Number.isFinite(nextId) || nextId <= 0) return
    await publishDrOtpBatch(userId, deviceId, dRoot, nextId, OTP_BATCH_SIZE)
  } catch { /* non-fatal */ }
}

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
  const setMyEcdhPublicKeyJwk = useSessionStore((s) => s.setMyEcdhPublicKeyJwk)
  const setPriorMyEcdhPublicKeysJwk = useSessionStore((s) => s.setPriorMyEcdhPublicKeysJwk)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const BiometricIcon = useBiometricIcon()
  const trapRef = useFocusTrap<HTMLDivElement>(true)

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

      // Cache the matching public JWK so the decrypt path can do a sender-aware
      // fallback (self-sent legacy DIRECT messages need MY public key, not peer's).
      const myPubJwk = exportEcdhPublicJwkFromPrivateKeyString(ecdhJwk)
      setMyEcdhPublicKeyJwk(myPubJwk)
      // Append-only history so historical messages encrypted to a previous
      // ECDH public key (after a vault re-import on the same device) can
      // still be decrypted via the fallback path.
      try {
        await recordEcdhPublicKey(userId, myPubJwk)
        const all = await listEcdhPublicKeys(userId)
        // Exclude the active key from the prior list — it's already in `myEcdhPublicKeyJwk`.
        setPriorMyEcdhPublicKeysJwk(all.filter((k) => k !== myPubJwk))
      } catch {
        /* best-effort: history is a recovery aid, not a hard requirement */
      }

      // If the user re-imported their vault while messages were waiting in
      // the outbox, the queued ciphertexts[] were encrypted to the previous
      // ECDH public key and recipients cannot decrypt them. Drop those
      // entries rather than silently poisoning conversations.
      void purgeOutboxStaleForKey(myPubJwk).catch(() => {
        /* best-effort: outbox is recoverable after reload anyway */
      })

      // Upload ECDH public key so fan-out can find this device.
      // Retry once — transient network errors are common on vault unlock.
      let ecdhUploaded = false
      for (let attempt = 0; attempt < 2 && !ecdhUploaded; attempt++) {
        try {
          await patchMyEcdhPublicKey(myPubJwk)
          ecdhUploaded = true
        } catch { /* retry */ }
      }
      if (!ecdhUploaded) {
        console.warn('[vault] ECDH key upload failed — this device may miss future messages')
      }

      // Derive a PER-DEVICE DR identity from the vault ECDH key and activate
      // it in-memory (track A4). The vault is per-user, so the stable
      // per-browser device id is mixed into the derivation — every linked
      // device thus owns a distinct identity / signed-prekey / OTP space and
      // publishes its OWN bundle to the device-scoped /keys directory (the
      // server resolves device_id from the session JWT).
      try {
        const deviceId = getOrCreateClientDeviceId()
        const dRoot = deriveDeviceDrRoot(ecdhJwk, deviceId)
        const bundle = deriveDrBundleFromEcdhJwk(ecdhJwk, deviceId)
        const wrapKey = await deriveSessionWrapKey(bundle.identity)
        setSessionWrapKey(wrapKey)
        setOwnDrIdentity(
          bundle.identity,
          bundle.signedPreKey,
          bundle.signedPreKeyId,
          deviceId,
          (id: number) => deriveOtpPrivKey(dRoot, id)
        )

        // Publish this device's identity + SPK on every unlock — the server
        // deduplicates by (user_id, device_id, generation) so this is
        // idempotent and self-healing if the server loses our keys.
        await publishIdentity({
          signing_public_key: encodeBase64Url(bundle.identity.signing.publicKey),
          exchange_public_key: encodeBase64Url(bundle.identity.exchange.publicKey),
          exchange_public_key_signature: encodeBase64Url(bundle.identityExchangeSignature),
          generation: 1,
        })
        await publishSignedPrekey({
          pre_key_id: bundle.signedPreKeyId,
          public_key: encodeBase64Url(bundle.signedPreKey.publicKey),
          signature: encodeBase64Url(bundle.signedPreKeySignature),
        })
        // Ensure this device's OTP pool is healthy; publish initial batch if empty.
        await replenishOtpsIfNeeded(userId, deviceId, dRoot)
      } catch { /* DR setup is non-fatal; v1 fanout still works */ }

      setPin('')
    },
    [setUnwrappedPrivateKey, setMyEcdhPublicKeyJwk, setPriorMyEcdhPublicKeysJwk, t, userId]
  )

  // Tauri desktop path: if the OS keychain already holds the PIN for this
  // user, transparently unlock without prompting. The PIN gets saved to
  // the keychain after the first successful manual unlock below. On web
  // and Capacitor this is a no-op.
  useEffect(() => {
    if (!isKeychainAvailable()) return
    let cancelled = false
    void (async () => {
      const slot = `vault-pin:${userId}`
      const stashed = await keychainGet(slot)
      if (cancelled || !stashed) return
      try {
        const blob = readVaultBlob(userId)
        if (!blob) return
        if (blob.version > CURRENT_VAULT_VERSION) return
        setBusy(true)
        const plain = await unwrapPrivateJwkWithPin(blob, stashed)
        if (cancelled) return
        await applyPlaintext(plain)
      } catch {
        // PIN in keychain is stale (rotation / corruption) — fall back
        // to the manual prompt and let the next successful unlock
        // overwrite the slot.
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, applyPlaintext])

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
          .then((upgraded) => {
            persistVaultBlob(userId, upgraded)
            // Sync upgraded blob to server immediately — runPostLoginVaultSync
            // may already have run before Argon2id finished.
            return runPostLoginVaultSync(userId)
          })
          .catch(() => { /* non-fatal — user stays on legacy vault */ })
      }
      // Tauri desktop: stash the PIN in the OS keychain so the next
      // launch can unlock silently. No-op on web / Capacitor.
      if (isKeychainAvailable()) {
        void keychainSet(`vault-pin:${userId}`, pin).catch(() => {
          /* best-effort */
        })
      }
      await applyPlaintext(plain)
      vibrateShort(20)
    } catch (err) {
      if (err instanceof VaultVersionMismatchError) {
        setError(t('login.vaultVersionMismatch'))
      } else {
        // The vault format itself is validated downstream (parseVaultPlaintext →
        // invalidVaultFormat); a failure here is almost always a mistyped
        // password, so use the friendlier wording.
        setError(t('login.unwrapFailedPassword'))
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
      ref={trapRef}
      className={`fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto px-4 py-4 ${
        isMd3
          ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm'
          : 'bg-void/95 backdrop-blur-md'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Key vault"
    >
      <div className={`p13-dialog-panel p13-dialog-scroll w-full max-w-sm space-y-6 p-6 ${
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
          <p className={`mt-1 text-[9px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-widest text-text-muted/70'}`}>
            {t('login.pinMin8')}
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
              {busy ? t('vault.unlocking') : t('login.signIn')}
            </button>
          ) : (
            <TerminalGlitchButton type="submit" disabled={busy} aria-label="UNLOCK" className="w-full">
              {busy ? `[ ${t('vault.unlocking')} ]` : t('login.signIn')}
            </TerminalGlitchButton>
          )}
          <div className={`space-y-2 border-t pt-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-neon-cyan/25'}`}>
            <p className={`text-[10px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-widest text-text-muted/80'}`}>
              {t('login.switchAccountHint')}
            </p>
            <LogoutButton className="w-full" />
          </div>
        </form>
      </div>
    </div>
  )
}

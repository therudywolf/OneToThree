'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import { useThemeStore } from '@/store/themeStore'
import {
  generateSafetyNumber,
  hashPublicKeyJwk,
} from '@/lib/crypto'
import {
  acknowledgeTrustRegistryCorruption,
  isTrustRegistryCorrupt,
  resolveTrustStatus,
  revokeVerifiedTrust,
  setVerifiedHash,
} from '@/lib/trust-store'
import {
  approveContact,
  isApprovedContact,
  revokeContact,
} from '@/lib/contacts-store'
import { useTranslation } from '@/hooks/use-translation'
import { computeSafetyNumber } from '@/lib/ratchet/safety-number'
import {
  sessionIdentityKeys,
  getSessionPeerIdentity,
  clearDrSession,
} from '@/lib/ratchet/session-manager'
import { SafetyNumberDisplay } from '@/components/chat/safety-number-display'

/**
 * ONETOTHREE :: NODE_INTEGRITY_CHECK
 * Level: Identity Layer (Zero-Trust Validation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

type Props = {
  peerUserId: string
  peerUsername: string
  peerEcdhPublicKeyJwk: string
  myEcdhPublicKeyJwk: string
  /** Local owner user id — used for DR session fingerprint lookup. */
  myUserId?: string
  onClose: () => void
  onTrustChanged?: (verified: boolean) => void
  onContactApprovedChanged?: (approved: boolean) => void
}

export function IdentityModal({
  peerUserId,
  peerUsername,
  peerEcdhPublicKeyJwk,
  myEcdhPublicKeyJwk,
  myUserId,
  onClose,
  onTrustChanged,
  onContactApprovedChanged,
}: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const isMd3 = shellMode === 'md3'
  const [nodeFingerprint, setNodeFingerprint] = useState('...')
  const [drSafetyNumber, setDrSafetyNumber] = useState<string | null>(null)
  const [keyHash, setKeyHash] = useState('')
  const [isTrusted, setIsTrusted] = useState(false)
  const [isApproved, setIsApproved] = useState(false)
  const [isCompromised, setIsCompromised] = useState(false)
  const [tofuChanged, setTofuChanged] = useState(false)
  const [isScanning, setIsScanning] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsScanning(true)

    void (async () => {
      try {
        const peerJwk = JSON.parse(peerEcdhPublicKeyJwk) as JsonWebKey
        const myJwk = JSON.parse(myEcdhPublicKeyJwk) as JsonWebKey
        const [fp, hash] = await Promise.all([
          generateSafetyNumber(myJwk, peerJwk),
          hashPublicKeyJwk(peerJwk),
        ])

        if (cancelled) return

        setNodeFingerprint(fp)
        setKeyHash(hash)

        const { verified, revokedByKeyChange } = resolveTrustStatus(peerUserId, hash)
        setIsTrusted(verified)
        setIsCompromised(revokedByKeyChange)
        setIsApproved(isApprovedContact(peerUserId))

        // DR safety number (if a session exists)
        if (myUserId) {
          // Feed the two RAW identity-signing keys to computeSafetyNumber — it
          // does the Signal length-prefixing and order-independent sorting
          // itself. The previous code hashed them first and then sliced bytes
          // 32..64 out of a 32-byte digest, so the peer half was always empty
          // and the number could never match the one the peer read out.
          const ids = await sessionIdentityKeys(myUserId, peerUserId)
          if (ids && !cancelled) {
            const drNum = computeSafetyNumber(ids.own, ids.peer, myUserId, peerUserId)
            setDrSafetyNumber(drNum)
          }
          // TOFU: check if server bundle identity differs from session identity
          const storedIdentity = await getSessionPeerIdentity(myUserId, peerUserId)
          if (storedIdentity) {
            try {
              const { fetchBundle } = await import('@/lib/api/keys')
              const bundle = await fetchBundle(peerUserId)
              // server returns base64url; storedIdentity is also base64url
              if (bundle.identity.exchange_public_key !== storedIdentity && !cancelled) setTofuChanged(true)
            } catch { /* non-fatal */ }
          }
        }
      } catch (err) {
        console.error('[SYS.CRYPTO] Integrity check failed:', err)
      } finally {
        if (!cancelled) setIsScanning(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [peerEcdhPublicKeyJwk, myEcdhPublicKeyJwk, peerUserId, myUserId])

  const toggleTrustProtocol = () => {
    if (!keyHash) return
    
    if (isTrusted) {
      revokeVerifiedTrust(peerUserId)
      setIsTrusted(false)
      setIsCompromised(false)
      onTrustChanged?.(false)
      return
    }
    
    // If the registry was previously detected corrupt, the user has now
    // visually confirmed at least one safety number — accept that as the
    // explicit re-verification gate the audit requires before silently
    // re-pinning peers.
    if (isTrustRegistryCorrupt()) {
      acknowledgeTrustRegistryCorruption()
    }
    try {
      setVerifiedHash(peerUserId, keyHash)
    } catch (err) {
      console.error('[SYS.TRUST] pin rejected:', err)
      return
    }
    setIsTrusted(true)
    setIsCompromised(false)
    onTrustChanged?.(true)
  }

  const toggleContactApproval = () => {
    if (isApproved) {
      revokeContact(peerUserId)
      setIsApproved(false)
      onContactApprovedChanged?.(false)
      return
    }
    approveContact(peerUserId)
    setIsApproved(true)
    onContactApprovedChanged?.(true)
  }

  if (isMd3) {
    return (
      <div
        ref={trapRef}
        className="fixed inset-0 z-[140] flex items-center justify-center overflow-y-auto bg-void/40 px-4 py-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <div className="p13-dialog-panel p13-dialog-scroll relative w-full max-w-md rounded-[28px] bg-[var(--surface)] p-6 shadow-[var(--md3-elevation-3,0_8px_24px_rgba(0,0,0,0.18))]">
          <header className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${isTrusted ? 'bg-neon-cyan/70' : 'animate-pulse bg-neon-red'}`} />
              <p className="text-sm font-medium text-[var(--on-surface)]">
                {t('identity.title')} — {peerUsername}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--on-surface-variant)] transition-colors hover:bg-[var(--surface-variant)]"
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--on-surface-variant)]">
                {t('identity.fingerprint')}
              </p>
              <div className="rounded-2xl bg-[var(--surface-variant)] px-4 py-3">
                <pre className="overflow-x-auto text-xs font-mono tracking-[0.25em] text-[var(--on-surface)] custom-scrollbar whitespace-pre-wrap break-all">
                  {isScanning ? '…' : nodeFingerprint}
                </pre>
              </div>
              <p className="text-xs text-[var(--on-surface-variant)]">
                {t('identity.verifyHint')}
              </p>
            </div>

            {drSafetyNumber && (
              <SafetyNumberDisplay safetyNumber={drSafetyNumber} />
            )}

            {isCompromised && (
              <div className="rounded-2xl bg-danger/10 p-3 text-sm text-neon-red">
                {t('identity.compromisedAlert')}
              </div>
            )}

            {tofuChanged && (
              <div className="space-y-3 rounded-2xl bg-danger/10 p-4">
                <p className="text-sm text-neon-red">
                  ⚠ {t('identity.tofuChanged')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (!myUserId) return
                    void clearDrSession(myUserId, peerUserId).then(() => {
                      setTofuChanged(false)
                      setDrSafetyNumber(null)
                    })
                  }}
                  className="rounded-full bg-danger/80 px-4 py-2 text-xs font-medium text-[var(--surface)] hover:bg-danger"
                >
                  {t('identity.acceptNewKey')}
                </button>
              </div>
            )}

            <div className="space-y-2 pt-1">
              <button
                type="button"
                disabled={isScanning || !keyHash}
                onClick={toggleTrustProtocol}
                className={`h-10 w-full rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40 ${
                  isTrusted
                    ? 'bg-danger/10 text-neon-red hover:bg-danger/20'
                    : 'bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90'
                }`}
              >
                {isTrusted ? t('identity.revokeTrust') : t('identity.validateIdentity')}
              </button>
              <button
                type="button"
                disabled={!isTrusted || isScanning}
                onClick={toggleContactApproval}
                className={`h-10 w-full rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40 ${
                  isApproved
                    ? 'bg-danger/10 text-neon-red hover:bg-danger/20'
                    : 'bg-[var(--secondary-container)] text-[var(--on-secondary-container)] hover:opacity-90'
                }`}
              >
                {isApproved ? t('identity.removeContact') : t('identity.addToContacts')}
              </button>
              <p className="text-center text-xs text-[var(--on-surface-variant)]">
                {isApproved ? t('identity.contactApproved') : t('identity.contactNotApproved')}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-[140] flex items-center justify-center overflow-y-auto bg-void/90 px-4 py-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="p13-dialog-panel p13-dialog-scroll relative w-full max-w-md border border-border-strong bg-void p-6 shadow-2xl">
        {/* TOP_DECOR_LINE */}
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

        <header className="mb-6 flex items-center justify-between border-b border-border-strong pb-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 ${isTrusted ? 'bg-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.5)]' : 'animate-pulse bg-neon-red'}`} />
            <p className="text-[10px] uppercase tracking-[0.4em] text-text-muted">
              SYS.INTEGRITY // {peerUsername}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="inline-flex h-8 w-8 items-center justify-center border border-border-strong bg-void text-text-muted/70 transition-colors hover:border-neon-red hover:text-neon-red"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-6">
          {/* FINGERPRINT_SECTION */}
          <div className="space-y-3">
            <p className="text-[9px] uppercase tracking-widest text-text-muted/70">
              NODE_FINGERPRINT
            </p>
            <div className="relative border border-border-strong bg-void px-4 py-3">
              <pre className="overflow-x-auto font-mono text-sm tracking-[0.3em] text-neon-cyan custom-scrollbar">
                {isScanning ? 'SCANNING_ELECTROMAGNETIC_TRAIL...' : nodeFingerprint}
              </pre>
            </div>
            <p className="text-[9px] leading-relaxed text-text-muted/70">
              {`> ${t('identity.verifyHint')}`}
            </p>
          </div>

          {/* DR_SAFETY_NUMBER */}
          {drSafetyNumber && (
            <SafetyNumberDisplay safetyNumber={drSafetyNumber} />
          )}

          {/* ALERT_SECTION */}
          {isCompromised && (
            <div className="border border-neon-red/50 bg-neon-red/5 p-3 font-mono text-[10px] text-neon-red animate-pulse">
              {t('identity.compromisedAlert')}
            </div>
          )}

          {/* TOFU_CHANGE_ALERT */}
          {tofuChanged && (
            <div className="space-y-2 border border-neon-red/70 bg-neon-red/5 p-3">
              <p className="font-mono text-[10px] text-neon-red">
                ⚠ IDENTITY_KEY_CHANGED — peer&apos;s DR key differs from stored session.
                Verify with the peer before accepting.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!myUserId) return
                  void clearDrSession(myUserId, peerUserId).then(() => {
                    setTofuChanged(false)
                    setDrSafetyNumber(null)
                  })
                }}
                className="h-8 border border-neon-red px-3 font-mono text-[9px] uppercase tracking-widest text-neon-red hover:bg-neon-red hover:text-text-primary"
              >
                Accept new key &amp; reset session
              </button>
            </div>
          )}

          {/* ACTION_CONTROL */}
          <div className="space-y-2">
            <button
              type="button"
              disabled={isScanning || !keyHash}
              onClick={toggleTrustProtocol}
              className={`h-10 w-full border px-3 font-mono text-[10px] uppercase tracking-[0.3em] transition-all ${
                isTrusted
                  ? 'border-neon-red text-neon-red hover:bg-neon-red hover:text-text-primary'
                  : 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'
              } disabled:opacity-20`}
            >
              {isTrusted ? t('identity.revokeTrust') : t('identity.validateIdentity')}
            </button>
            <button
              type="button"
              disabled={!isTrusted || isScanning}
              onClick={toggleContactApproval}
              className={`h-10 w-full border px-3 font-mono text-[10px] uppercase tracking-[0.3em] transition-all ${
                isApproved
                  ? 'border-neon-red/60 text-neon-red hover:bg-neon-red/10'
                  : 'border-neon-cyan/70 text-neon-cyan hover:bg-neon-cyan/10'
              } disabled:opacity-20`}
            >
              {isApproved ? t('identity.removeContact') : t('identity.addToContacts')}
            </button>
            <p className="text-[9px] text-text-muted/70">
              {isApproved
                ? t('identity.contactApproved')
                : t('identity.contactNotApproved')}
            </p>
          </div>
        </div>

        {/* FOOTER_MARK */}
        <footer className="mt-8 pt-4 border-t border-border-strong/50">
          <p className="text-center text-[8px] uppercase tracking-widest text-text-muted/50">
            ONETOTHREE // Zero-Knowledge Verification
          </p>
        </footer>
      </div>
    </div>
  )
}

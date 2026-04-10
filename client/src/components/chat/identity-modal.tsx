'use client'

import { useEffect, useState } from 'react'
import {
  generateSafetyNumber,
  hashPublicKeyJwk,
} from '@/lib/crypto'
import {
  resolveTrustStatus,
  revokeVerifiedTrust,
  setVerifiedHash,
} from '@/lib/trust-store'

type Props = {
  peerUserId: string
  peerUsername: string
  peerEcdhPublicKeyJwk: string
  onClose: () => void
  onTrustChanged?: (verified: boolean) => void
}

export function IdentityModal({
  peerUserId,
  peerUsername,
  peerEcdhPublicKeyJwk,
  onClose,
  onTrustChanged,
}: Props) {
  const [safetyNumber, setSafetyNumber] = useState('...')
  const [keyHash, setKeyHash] = useState('')
  const [verified, setVerified] = useState(false)
  const [revokedByKeyChange, setRevokedByKeyChange] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void (async () => {
      try {
        const jwk = JSON.parse(peerEcdhPublicKeyJwk) as JsonWebKey
        const [number, hash] = await Promise.all([
          generateSafetyNumber(jwk),
          hashPublicKeyJwk(jwk),
        ])
        if (cancelled) return
        setSafetyNumber(number)
        setKeyHash(hash)
        const trust = resolveTrustStatus(peerUserId, hash)
        setVerified(trust.verified)
        setRevokedByKeyChange(trust.revokedByKeyChange)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [peerEcdhPublicKeyJwk, peerUserId])

  function toggleTrust() {
    if (!keyHash) return
    if (verified) {
      revokeVerifiedTrust(peerUserId)
      setVerified(false)
      setRevokedByKeyChange(false)
      onTrustChanged?.(false)
      return
    }
    setVerifiedHash(peerUserId, keyHash)
    setVerified(true)
    setRevokedByKeyChange(false)
    onTrustChanged?.(true)
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Identity verification"
    >
      <div className="terminal-panel w-full max-w-md space-y-4">
        <header className="flex items-center justify-between border-b border-neon-red/40 pb-2">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ VERIFY_IDENTITY ] :: {peerUsername}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-neon-red hover:text-neon-cyan"
          >
            [X]
          </button>
        </header>

        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-red-800">
            SAFETY_NUMBER
          </p>
          <pre className="overflow-x-auto border border-neon-cyan/40 px-3 py-2 font-mono text-sm tracking-[0.2em] text-neon-cyan">
            {safetyNumber}
          </pre>
          <p className="font-mono text-[10px] text-red-800">
            Compare this value out-of-band with your contact.
          </p>
          {revokedByKeyChange ? (
            <p className="border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red">
              [!] TRUST_REVOKED :: KEY_CHANGED
            </p>
          ) : null}
        </div>

        <button
          type="button"
          disabled={busy || !keyHash}
          onClick={toggleTrust}
          className="border border-neon-cyan bg-black px-4 py-2 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:border-neon-red hover:text-neon-red disabled:opacity-40"
        >
          {verified ? '[ REVOKE_TRUST ]' : '[ VERIFY_CONTACT ]'}
        </button>
      </div>
    </div>
  )
}


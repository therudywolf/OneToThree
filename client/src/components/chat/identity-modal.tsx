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

/**
 * PROJECT 13 :: NODE_INTEGRITY_CHECK
 * Level: Identity Layer (Zero-Trust Validation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

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
  const [nodeFingerprint, setNodeFingerprint] = useState('...')
  const [keyHash, setKeyHash] = useState('')
  const [isTrusted, setIsTrusted] = useState(false)
  const [isCompromised, setIsCompromised] = useState(false)
  const [isScanning, setIsScanning] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsScanning(true)
    
    void (async () => {
      try {
        const jwk = JSON.parse(peerEcdhPublicKeyJwk) as JsonWebKey
        const [fingerprint, hash] = await Promise.all([
          generateSafetyNumber(jwk),
          hashPublicKeyJwk(jwk),
        ])
        
        if (cancelled) return
        
        setNodeFingerprint(fingerprint)
        setKeyHash(hash)
        
        const { verified, revokedByKeyChange } = resolveTrustStatus(peerUserId, hash)
        setIsTrusted(verified)
        setIsCompromised(revokedByKeyChange)
      } catch (err) {
        console.error('[SYS.CRYPTO] Integrity check failed:', err)
      } finally {
        if (!cancelled) setIsScanning(false)
      }
    })()
    
    return () => {
      cancelled = true
    }
  }, [peerEcdhPublicKeyJwk, peerUserId])

  const toggleTrustProtocol = () => {
    if (!keyHash) return
    
    if (isTrusted) {
      revokeVerifiedTrust(peerUserId)
      setIsTrusted(false)
      setIsCompromised(false)
      onTrustChanged?.(false)
      return
    }
    
    setVerifiedHash(peerUserId, keyHash)
    setIsTrusted(true)
    setIsCompromised(false)
    onTrustChanged?.(true)
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-zinc-950/90 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md border border-neutral-900 bg-black p-6 shadow-2xl">
        {/* TOP_DECOR_LINE */}
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-red to-transparent opacity-50" />

        <header className="mb-6 flex items-center justify-between border-b border-neutral-900 pb-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 ${isTrusted ? 'bg-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.5)]' : 'animate-pulse bg-neon-red'}`} />
            <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-500">
              SYS.INTEGRITY // {peerUsername}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-700 transition-colors hover:text-neon-red"
          >
            [X]
          </button>
        </header>

        <div className="space-y-6">
          {/* FINGERPRINT_SECTION */}
          <div className="space-y-3">
            <p className="text-[9px] uppercase tracking-widest text-zinc-600">
              NODE_FINGERPRINT
            </p>
            <div className="relative border border-neutral-900 bg-zinc-950 px-4 py-3">
              <pre className="overflow-x-auto font-mono text-sm tracking-[0.3em] text-neon-cyan custom-scrollbar">
                {isScanning ? 'SCANNING_ELECTROMAGNETIC_TRAIL...' : nodeFingerprint}
              </pre>
            </div>
            <p className="text-[9px] leading-relaxed text-zinc-600">
              {">"} Сверь этот код с контактом через защищенный внешний канал.
            </p>
          </div>

          {/* ALERT_SECTION */}
          {isCompromised && (
            <div className="border border-neon-red/50 bg-neon-red/5 p-3 font-mono text-[10px] text-neon-red animate-pulse">
              [!] ALERT: TRUST_REVOKED // Ключ узла был изменен. Возможна попытка перехвата.
            </div>
          )}

          {/* ACTION_CONTROL */}
          <button
            type="button"
            disabled={isScanning || !keyHash}
            onClick={toggleTrustProtocol}
            className={`w-full border py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] transition-all ${
              isTrusted 
                ? 'border-neon-red text-neon-red hover:bg-neon-red hover:text-black' 
                : 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan hover:text-black'
            } disabled:opacity-20`}
          >
            {isTrusted ? '[ SEVER_TRUST_LINK ]' : '[ VALIDATE_IDENTITY ]'}
          </button>
        </div>

        {/* FOOTER_MARK */}
        <footer className="mt-8 pt-4 border-t border-neutral-900/50">
          <p className="text-center text-[8px] uppercase tracking-widest text-neutral-800">
            Project_13 // Zero-Knowledge Verification
          </p>
        </footer>
      </div>
    </div>
  )
}
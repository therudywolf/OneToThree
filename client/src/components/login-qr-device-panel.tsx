'use client'

import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import {
  generateLinkEphemeralKeypair,
  buildLinkQrPayload,
  decryptVaultFromEphemeralKey,
} from '@/lib/device-link-crypto'
import { createRendezvous, claimRendezvous } from '@/lib/api/device-rendezvous'
import { parseVaultBlobJson, persistVaultBlobByLoginUsername } from '@/lib/vault'

/**
 * PROJECT 13 :: NODE_LINKING_INTERFACE (new-device side)
 *
 * The new device generates an ephemeral ECDH keypair and shows a QR carrying
 * only its PUBLIC key. An already-signed-in device scans it, encrypts the
 * vault to that key, and deposits the ciphertext. This device then claims and
 * decrypts it — the server never sees a key that can read the vault.
 */

type Status = 'idle' | 'preparing' | 'waiting' | 'received' | 'error'

const POLL_INTERVAL_MS = 2500

export function LoginQrDevicePanel() {
  const { t } = useTranslation()

  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return false
    const w = window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }
    return Boolean(
      w.Capacitor?.isNativePlatform?.() ||
        window.matchMedia('(max-width: 768px)').matches
    )
  })
  const [status, setStatus] = useState<Status>('idle')
  const [qrValue, setQrValue] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  const stopRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cleanup = useCallback(() => {
    stopRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const startLink = useCallback(async () => {
    cleanup()
    stopRef.current = false
    setStatus('preparing')
    setErrorText(null)
    setQrValue(null)

    try {
      const kp = await generateLinkEphemeralKeypair()
      const rdv = await createRendezvous(kp.publicJwk)
      if (stopRef.current) return
      setQrValue(buildLinkQrPayload(rdv.rendezvous_id, kp.publicJwk))
      setStatus('waiting')

      const deadline = Date.now() + rdv.expires_in * 1000

      const poll = async (): Promise<void> => {
        if (stopRef.current) return
        if (Date.now() > deadline) {
          setStatus('error')
          setErrorText(t('login.qrShowExpired'))
          return
        }
        try {
          const res = await claimRendezvous(rdv.rendezvous_id, rdv.claim_secret)
          if (stopRef.current) return
          if (res.status === 'pending') {
            timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
            return
          }
          if (res.status === 'gone') {
            setStatus('error')
            setErrorText(t('login.qrShowExpired'))
            return
          }
          // ready — decrypt the vault handed off by the old device.
          const decrypted = await decryptVaultFromEphemeralKey(res.encBlob, kp.privateJwk)
          const handoff = JSON.parse(decrypted) as { username?: unknown; vault?: unknown }
          if (typeof handoff.username !== 'string' || handoff.vault == null) {
            throw new Error('BAD_HANDOFF')
          }
          const parsedVault = parseVaultBlobJson(JSON.stringify(handoff.vault))
          if (!parsedVault) throw new Error('BAD_VAULT')
          persistVaultBlobByLoginUsername(handoff.username, parsedVault)
          setStatus('received')
        } catch {
          if (stopRef.current) return
          setStatus('error')
          setErrorText(t('login.qrShowFailed'))
        }
      }

      timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } catch {
      if (stopRef.current) return
      setStatus('error')
      setErrorText(t('login.qrShowFailed'))
    }
  }, [cleanup, t])

  return (
    <div
      className={`mt-8 w-full p-1 transition-all ${
        isRetro
          ? 'p13-classic-strip'
          : 'border border-border-strong bg-void/40 backdrop-blur-sm'
      }`}
    >
      <div className={isRetro ? 'p13-window p-4' : 'border border-border-strong p-4'}>
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          data-testid="qr-link-toggle"
          className={`flex w-full items-center justify-between text-[10px] transition-colors ${
            isRetro
              ? 'p13-classic-copy-strong hover:text-[var(--danger)]'
              : 'font-mono uppercase tracking-[0.3em] text-neon-cyan hover:text-neon-red'
          }`}
        >
          <span>{t('login.qrLinkSection')}</span>
          <span className="text-right text-[8px] opacity-70">
            {isExpanded ? '[ − ]' : `// ${t('login.qrLinkRecommended')}`}
          </span>
        </button>

        {isExpanded && (
          <div className="mt-6 space-y-4">
            {status === 'idle' || status === 'error' ? (
              <>
                <p className="text-[9px] leading-relaxed text-text-muted/70">
                  {t('login.qrShowHint')}
                </p>
                {errorText && (
                  <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] uppercase tracking-widest text-neon-red">
                    [!] {errorText}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void startLink()}
                  className={`w-full border py-2.5 text-[10px] transition-all ${
                    isRetro
                      ? 'p13-classic-button'
                      : 'border-neon-cyan/60 bg-void font-mono uppercase tracking-[0.3em] text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'
                  }`}
                >
                  {`>> ${status === 'error' ? t('login.qrShowRetry') : t('login.qrShowStart')}`}
                </button>
              </>
            ) : status === 'preparing' ? (
              <p className="py-6 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted">
                [ ... ]
              </p>
            ) : status === 'waiting' && qrValue ? (
              <div className="space-y-3">
                <div className={`flex items-center justify-center p-4 ${isRetro ? 'p13-classic-inset' : 'border border-neon-cyan/25 bg-void'}`}>
                  <QRCodeSVG
                    value={qrValue}
                    size={200}
                    bgColor="#000000"
                    fgColor="#22d3ee"
                    level="M"
                    className="max-w-full"
                  />
                </div>
                <p className="text-center text-[9px] uppercase tracking-widest text-neon-cyan/80">
                  {t('login.qrShowWaiting')}
                </p>
              </div>
            ) : status === 'received' ? (
              <div className="border border-neon-cyan/30 bg-neon-cyan/5 p-3 text-[9px] leading-relaxed text-neon-cyan">
                {t('login.qrShowReceived')}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

'use client'

import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'
import {
  generateLinkEphemeralKeypair,
  buildLinkQrPayload,
  decryptVaultFromEphemeralKey,
  parseLinkModeBQrPayload,
  parseVaultHandoffPayload,
  deriveLinkVerificationCode,
} from '@/lib/device-link-crypto'
import {
  createRendezvous,
  claimRendezvous,
  submitRendezvousPubkey,
} from '@/lib/api/device-rendezvous'
import { QrScanner } from '@/components/qr-scanner'
import { persistVaultBlobByLoginUsername } from '@/lib/vault'

/**
 * PROJECT 13 :: NODE_LINKING_INTERFACE (new-device side)
 *
 * Bidirectional QR device linking. The vault always flows existing -> new,
 * encrypted to a throwaway ECDH key the server never holds.
 *
 *  Mode A (show) — this device generates an ephemeral keypair and SHOWS a QR
 *    carrying its public key. The already-signed-in device scans it, encrypts
 *    the vault and deposits it. This device claims and decrypts.
 *
 *  Mode B (scan) — the already-signed-in device SHOWS the QR. This device
 *    scans it, generates an ephemeral keypair, submits its public key, then
 *    both devices display a 6-digit verification code derived from that key.
 *    Once the user confirms on the other device, this device claims the vault.
 */

type Mode = 'show' | 'scan'
type Status =
  | 'idle'
  | 'preparing'
  | 'waiting' // Mode A: QR shown, waiting for the other device
  | 'scanning' // Mode B: camera open
  | 'verifying' // Mode B: verification code shown, polling claim
  | 'received'
  | 'error'

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
  const [mode, setMode] = useState<Mode>('show')
  const [status, setStatus] = useState<Status>('idle')
  const [qrValue, setQrValue] = useState<string | null>(null)
  const [verificationCode, setVerificationCode] = useState<string | null>(null)
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

  /** Import a decrypted vault handoff blob; throws on a malformed payload. */
  const importHandoff = useCallback((decrypted: string) => {
    const { username, vault } = parseVaultHandoffPayload(decrypted)
    persistVaultBlobByLoginUsername(username, vault)
  }, [])

  // -------- Mode A: show a QR carrying this device's ephemeral key --------
  const startShowMode = useCallback(async () => {
    cleanup()
    stopRef.current = false
    setMode('show')
    setStatus('preparing')
    setErrorText(null)
    setQrValue(null)
    setVerificationCode(null)

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
          importHandoff(decrypted)
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
  }, [cleanup, importHandoff, t])

  // -------- Mode B: scan the QR shown by the signed-in device --------
  const beginScanMode = useCallback(() => {
    cleanup()
    stopRef.current = false
    setMode('scan')
    setStatus('scanning')
    setErrorText(null)
    setQrValue(null)
    setVerificationCode(null)
  }, [cleanup])

  /** Called by the QR scanner with each decoded payload. */
  const handleScan = useCallback(
    async (raw: string): Promise<boolean> => {
      const payload = parseLinkModeBQrPayload(raw)
      if (!payload) return false // not a Mode B QR — keep scanning

      try {
        // Generate this device's throwaway keypair and submit the public half.
        const kp = await generateLinkEphemeralKeypair()
        await submitRendezvousPubkey(
          payload.rendezvousId,
          kp.publicJwk,
          payload.claimSecret
        )
        if (stopRef.current) return true

        // Show the verification code so the user can match it on the other
        // device before that device deposits the vault.
        const code = await deriveLinkVerificationCode(
          payload.rendezvousId,
          kp.publicJwk
        )
        if (stopRef.current) return true
        setVerificationCode(code)
        setStatus('verifying')

        const deadline = Date.now() + 300 * 1000

        const poll = async (): Promise<void> => {
          if (stopRef.current) return
          if (Date.now() > deadline) {
            setStatus('error')
            setErrorText(t('login.qrShowExpired'))
            return
          }
          try {
            const res = await claimRendezvous(payload.rendezvousId, payload.claimSecret)
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
            const decrypted = await decryptVaultFromEphemeralKey(
              res.encBlob,
              kp.privateJwk
            )
            importHandoff(decrypted)
            setStatus('received')
          } catch {
            if (stopRef.current) return
            setStatus('error')
            setErrorText(t('login.qrScanModeFailed'))
          }
        }

        timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
      } catch {
        if (stopRef.current) return true
        setStatus('error')
        setErrorText(t('login.qrScanModeFailed'))
      }
      return true // a Mode B QR was consumed — stop the scanner
    },
    [importHandoff, t]
  )

  const tabButtonClass = (active: boolean) =>
    `flex-1 border py-2 text-[10px] uppercase tracking-widest transition-colors ${
      isRetro
        ? active
          ? 'p13-classic-button'
          : 'p13-classic-button opacity-60'
        : active
          ? 'border-neon-cyan bg-neon-cyan/10 font-mono text-neon-cyan'
          : 'border-neon-cyan/30 bg-void font-mono text-neon-cyan/50 hover:text-neon-cyan'
    }`

  const actionButtonClass = `w-full border py-2.5 text-[10px] transition-all ${
    isRetro
      ? 'p13-classic-button'
      : 'border-neon-cyan/60 bg-void font-mono uppercase tracking-[0.3em] text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'
  }`

  const isBusy = status === 'waiting' || status === 'verifying' || status === 'scanning'

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
            {/* Mode toggle. */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (mode !== 'show' || status === 'idle' || status === 'error') {
                    void startShowMode()
                  }
                }}
                disabled={isBusy && mode === 'show'}
                className={tabButtonClass(mode === 'show')}
              >
                {t('login.qrModeShow')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mode !== 'scan' || status === 'idle' || status === 'error') {
                    beginScanMode()
                  }
                }}
                disabled={isBusy && mode === 'scan'}
                className={tabButtonClass(mode === 'scan')}
              >
                {t('login.qrModeScan')}
              </button>
            </div>

            {errorText && (
              <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] uppercase tracking-widest text-neon-red">
                [!] {errorText}
              </div>
            )}

            {status === 'received' ? (
              <div className="border border-neon-cyan/30 bg-neon-cyan/5 p-3 text-[9px] leading-relaxed text-neon-cyan">
                {t('login.qrShowReceived')}
              </div>
            ) : mode === 'show' ? (
              <>
                {status === 'idle' || status === 'error' ? (
                  <>
                    <p className="text-[9px] leading-relaxed text-text-muted/70">
                      {t('login.qrShowHint')}
                    </p>
                    <button
                      type="button"
                      onClick={() => void startShowMode()}
                      className={actionButtonClass}
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
                    <div
                      className={`flex items-center justify-center p-4 ${
                        isRetro ? 'p13-classic-inset' : 'border border-neon-cyan/25 bg-void'
                      }`}
                    >
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
                ) : null}
              </>
            ) : (
              /* mode === 'scan' */
              <>
                {status === 'verifying' && verificationCode ? (
                  <div className="space-y-3">
                    <p
                      className={`text-center text-[10px] uppercase tracking-widest ${
                        isRetro ? 'p13-classic-copy-strong' : 'text-neon-cyan'
                      }`}
                    >
                      {t('login.qrVerifyTitle')}
                    </p>
                    <div
                      className={`flex items-center justify-center py-4 font-mono text-3xl tracking-[0.4em] ${
                        isRetro
                          ? 'p13-classic-inset'
                          : 'border border-neon-cyan/40 bg-void text-neon-cyan'
                      }`}
                      data-testid="link-verification-code"
                    >
                      {verificationCode}
                    </div>
                    <p className="break-words text-[9px] leading-relaxed text-text-muted/80">
                      {t('login.qrVerifyInstruction')}
                    </p>
                    <p className="text-center text-[9px] uppercase tracking-widest text-neon-cyan/80">
                      {t('login.qrVerifyWaiting')}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-[9px] leading-relaxed text-text-muted/70">
                      {t('login.qrScanModeHint')}
                    </p>
                    <QrScanner
                      onScan={handleScan}
                      processing={status === 'verifying'}
                      isRetro={isRetro}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

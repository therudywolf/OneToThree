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

/**
 * `embedded` = the caller already supplies the frame, the title and the
 * open/close control (see the auth screens' DeviceLinkDisclosure), so this
 * component drops its own outer chrome and stays permanently expanded instead of
 * drawing a second box with a second title inside the first.
 */
export function LoginQrDevicePanel({ embedded = false }: { embedded?: boolean } = {}) {
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
  // Live expiry countdown for the waiting (Mode A) / verifying (Mode B) phases.
  const [deadlineTs, setDeadlineTs] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  // Manual-code fallback (scan side).
  const [manualOpen, setManualOpen] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [manualError, setManualError] = useState(false)

  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  // This panel previously derived ONLY isRetro, so on the DEFAULT shell (md3) it
  // rendered raw terminal chrome — mono caps, '>>' prefixes, cyan-on-black —
  // directly beneath a Material surface.
  const isMd3 = shellMode === 'md3'

  const stopRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Separate interval for the countdown — distinct from timerRef (polling).
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cleanup = useCallback(() => {
    stopRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Drive the 1-second "Expires in M:SS" countdown while a deadline is set and
  // we are waiting/verifying. Cleared on unmount, status change, deadline clear.
  useEffect(() => {
    if (deadlineTs === null || (status !== 'waiting' && status !== 'verifying')) {
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
      setSecondsLeft(null)
      return
    }
    const tick = () => {
      setSecondsLeft(Math.max(0, Math.ceil((deadlineTs - Date.now()) / 1000)))
    }
    tick()
    countdownRef.current = setInterval(tick, 1000)
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
    }
  }, [deadlineTs, status])

  useEffect(
    () => () => {
      cleanup()
      if (countdownRef.current) clearInterval(countdownRef.current)
    },
    [cleanup]
  )

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
    setDeadlineTs(null)

    try {
      const kp = await generateLinkEphemeralKeypair()
      const rdv = await createRendezvous(kp.publicJwk)
      if (stopRef.current) return
      setQrValue(buildLinkQrPayload(rdv.rendezvous_id, kp.publicJwk, rdv.deposit_secret))
      setStatus('waiting')

      const deadline = Date.now() + rdv.expires_in * 1000
      setDeadlineTs(deadline)

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
    setDeadlineTs(null)
    setManualError(false)
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
        setDeadlineTs(deadline)

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

  // Manual-code fallback: feed the pasted code to the SAME handler the QR
  // scanner uses. handleScan returns false when the string isn't a Mode B
  // payload, so we surface a gentle "that code doesn't look right" hint.
  const submitManualCode = useCallback(async () => {
    const raw = manualCode.trim()
    if (!raw) return
    setManualError(false)
    const accepted = await handleScan(raw)
    if (!accepted) {
      setManualError(true)
    }
  }, [manualCode, handleScan])

  const formattedCountdown =
    secondsLeft === null
      ? null
      : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

  // New-device step indicator: 1 Show/Scan · 2 Compare codes · 3 Receiving.
  const stepLabels = [
    t('login.qrStepShowScan'),
    t('login.qrStepCompare'),
    t('login.qrStepReceiving'),
  ]
  const activeStep =
    status === 'received'
      ? 2
      : status === 'verifying'
        ? 1
        : status === 'idle' ||
            status === 'preparing' ||
            status === 'waiting' ||
            status === 'scanning'
          ? 0
          : -1 // error — indicator hidden

  const tabButtonClass = (active: boolean) =>
    isMd3
      ? `flex-1 rounded-full py-2 text-[11px] transition-colors ${
          active
            ? 'bg-[var(--surface)] font-medium text-[var(--on-surface)] shadow-[var(--md3-elevation-1)]'
            : 'text-text-muted hover:text-[var(--on-surface)]'
        }`
      : `flex-1 border py-2 text-[10px] uppercase tracking-widest transition-colors ${
          isRetro
            ? active
              ? 'p13-classic-button'
              : 'p13-classic-button opacity-60'
            : active
              ? 'border-neon-cyan bg-neon-cyan/10 font-mono text-neon-cyan'
              : 'border-neon-cyan/30 bg-void font-mono text-neon-cyan/50 hover:text-neon-cyan'
        }`

  const actionButtonClass = isMd3
    ? 'w-full rounded-full bg-[var(--neon-red)] py-2.5 text-[12px] font-medium text-[var(--surface)] transition-opacity hover:opacity-90'
    : `w-full border py-2.5 text-[10px] transition-all ${
        isRetro
          ? 'p13-classic-button'
          : 'border-neon-cyan/60 bg-void font-mono uppercase tracking-[0.3em] text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'
      }`

  /** Wrap the mode tabs in a pill track on MD3, plain flex elsewhere. */
  const tabTrackClass = isMd3
    ? 'flex gap-1 rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] p-1'
    : 'flex gap-2'

  /** Terminal affordances ('>>' prefixes, '[ ± ]' markers) are part of that
   *  shell's language — on Material they just read as stray punctuation. */
  const arrow = (label: string) => (isMd3 ? label : `>> ${label}`)
  const marker = (open: boolean) => (isMd3 ? (open ? '−' : '+') : open ? '[ − ]' : '[ + ]')

  const isBusy = status === 'waiting' || status === 'verifying' || status === 'scanning'

  const showChrome = !embedded
  const expanded = embedded || isExpanded

  return (
    <div
      className={
        embedded
          ? 'w-full'
          : `mt-8 w-full p-1 transition-all ${
              isRetro
                ? 'p13-classic-strip'
                : 'border border-border-strong bg-void/40 backdrop-blur-sm'
            }`
      }
    >
      <div
        className={
          embedded ? '' : isRetro ? 'p13-window p-4' : 'border border-border-strong p-4'
        }
      >
        {showChrome && (
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            data-testid="qr-link-toggle"
            className={`flex w-full items-center justify-between text-[10px] transition-colors ${
              isRetro
                ? 'p13-classic-copy-strong hover:text-[var(--danger)]'
                : isMd3
                  ? 'font-medium text-[var(--on-surface)]'
                  : 'font-mono uppercase tracking-[0.3em] text-neon-cyan hover:text-neon-red'
            }`}
          >
            <span>{t('login.qrLinkSection')}</span>
            <span className="text-right text-[8px] opacity-70">
              {isExpanded ? marker(true) : `// ${t('login.qrLinkRecommended')}`}
            </span>
          </button>
        )}

        {expanded && (
          <div className="mt-6 space-y-4" data-testid="qr-link-panel">
            {/* Mode toggle. */}
            <div className={tabTrackClass}>
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

            {/* Step indicator — derived from status. */}
            {activeStep >= 0 && (
              <ol className="flex items-center gap-1" aria-label={stepLabels.join(' · ')}>
                {stepLabels.map((label, i) => {
                  const reached = i <= activeStep
                  return (
                    <li
                      key={label}
                      aria-current={i === activeStep ? 'step' : undefined}
                      className={`flex-1 truncate border px-1.5 py-1 text-center text-[8px] uppercase tracking-wider transition-colors ${
                        isRetro
                          ? reached
                            ? 'p13-classic-button'
                            : 'p13-classic-button opacity-50'
                          : reached
                            ? 'border-neon-cyan bg-neon-cyan/10 font-mono text-neon-cyan'
                            : 'border-neon-cyan/20 bg-void font-mono text-neon-cyan/40'
                      }`}
                    >
                      <span className="mr-1 opacity-70">{i + 1}</span>
                      {label}
                    </li>
                  )
                })}
              </ol>
            )}

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
                      {arrow(status === 'error' ? t('login.qrShowRetry') : t('login.qrShowStart'))}
                    </button>
                  </>
                ) : status === 'preparing' ? (
                  <p className="py-6 text-center text-[10px] tracking-widest text-text-muted">
                    {isMd3 ? '…' : '[ ... ]'}
                  </p>
                ) : status === 'waiting' && qrValue ? (
                  <div className="space-y-3">
                    {/* The code itself always renders DARK-ON-WHITE inside its own
                        tile, on every theme. Camera decoders expect a light quiet
                        zone, and the old cyan-on-black (#22d3ee on #000000) was
                        both off-theme and needlessly hard to scan. The tile is
                        what carries the theme, not the code. */}
                    <div
                      className={`flex items-center justify-center p-4 ${
                        isRetro
                          ? 'p13-classic-inset'
                          : isMd3
                            ? 'rounded-[20px] bg-white'
                            : 'border border-neon-cyan/25 bg-white'
                      }`}
                    >
                      <QRCodeSVG
                        value={qrValue}
                        size={224}
                        bgColor="#ffffff"
                        fgColor="#111111"
                        level="M"
                        className="h-auto w-full max-w-[280px]"
                      />
                    </div>
                    <p className={`text-center text-[11px] leading-relaxed ${isRetro ? 'p13-classic-copy' : 'text-text-muted/70'}`}>
                      {t('settings.linkQrAimHint')}
                    </p>
                    <p className="text-center text-[9px] uppercase tracking-widest text-neon-cyan/80">
                      {t('login.qrShowWaiting')}
                    </p>
                    {formattedCountdown && (
                      <p className="text-center text-[9px] leading-relaxed text-text-muted/70">
                        {`${t('login.qrExpiresIn')} ${formattedCountdown}`}
                      </p>
                    )}
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
                    {formattedCountdown && (
                      <p className="text-center text-[9px] leading-relaxed text-text-muted/70">
                        {`${t('login.qrExpiresIn')} ${formattedCountdown}`}
                      </p>
                    )}
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

                    {/* Manual-code fallback: paste the code shown under the QR
                        on the other device — feeds the same handler. */}
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => setManualOpen((prev) => !prev)}
                        aria-expanded={manualOpen}
                        data-testid="qr-manual-toggle"
                        className={`flex w-full items-center justify-between text-[9px] transition-colors ${
                          isRetro
                            ? 'p13-classic-copy-strong hover:text-[var(--danger)]'
                            : 'font-mono uppercase tracking-widest text-neon-cyan/80 hover:text-neon-cyan'
                        }`}
                      >
                        <span>{t('login.qrManualScanLabel')}</span>
                        <span className="opacity-70">{marker(manualOpen)}</span>
                      </button>
                      {manualOpen && (
                        <div className="mt-2 space-y-2">
                          <p className="text-[9px] leading-relaxed text-text-muted/70">
                            {t('login.qrManualScanHint')}
                          </p>
                          <textarea
                            value={manualCode}
                            onChange={(e) => {
                              setManualCode(e.target.value)
                              if (manualError) setManualError(false)
                            }}
                            rows={3}
                            spellCheck={false}
                            autoCapitalize="none"
                            autoCorrect="off"
                            data-testid="qr-manual-input"
                            placeholder={t('login.qrManualScanPlaceholder')}
                            className={`w-full resize-none break-all p-2 font-mono text-[9px] leading-relaxed ${
                              isRetro
                                ? 'p13-classic-inset'
                                : 'border border-neon-cyan/25 bg-void text-neon-cyan/90 placeholder:text-text-muted/50'
                            }`}
                          />
                          {manualError && (
                            <p className="text-[9px] leading-relaxed text-neon-red">
                              {t('login.qrManualScanInvalid')}
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={() => void submitManualCode()}
                            disabled={!manualCode.trim()}
                            data-testid="qr-manual-submit"
                            className={`${actionButtonClass} disabled:opacity-50`}
                          >
                            {arrow(t('login.qrManualScanSubmit'))}
                          </button>
                        </div>
                      )}
                    </div>
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

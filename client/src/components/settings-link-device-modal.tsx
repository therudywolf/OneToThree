'use client'

import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { VaultPinGate } from '@/components/vault-pin-gate'
import { useAuth } from '@/components/auth/auth-provider'
import { readVaultBlob } from '@/lib/vault'
import { useThemeStore } from '@/store/themeStore'
import { explainDeviceLinkError } from '@/lib/device-link-errors'
import { PortalRoot } from '@/components/portal-root'
import { acquireBodyScrollLock } from '@/lib/body-scroll-lock'
import { QrScanner } from '@/components/qr-scanner'
import { X } from 'lucide-react'
import {
  parseLinkQrPayload,
  encryptVaultToEphemeralKey,
  buildLinkModeBQrPayload,
  deriveLinkVerificationCode,
} from '@/lib/device-link-crypto'
import {
  depositToRendezvous,
  createRendezvous,
  getRendezvousStatus,
} from '@/lib/api/device-rendezvous'

type Props = { onClose: () => void }
/**
 * gate     — vault-PIN re-auth.
 * mode     — pick Mode A (scan) or Mode B (show).
 * scan     — Mode A: scan the QR the new device shows.
 * showqr   — Mode B: show a QR, poll until the new device submits its key.
 * verify   — Mode B: compare the verification code, require explicit confirm.
 * done     — vault deposited.
 */
type Phase = 'gate' | 'mode' | 'scan' | 'showqr' | 'verify' | 'done'

const POLL_INTERVAL_MS = 2500

/**
 * Existing (logged-in) device side of bidirectional P2P device linking. After
 * a vault-PIN re-auth the user picks a direction:
 *
 *  Mode A (scan) — the new device shows the QR; this device scans it, encrypts
 *    the vault to that device's ephemeral key, and deposits the ciphertext.
 *
 *  Mode B (show) — this device shows the QR. The new device scans it and
 *    submits its ephemeral key; both devices then display a 6-digit code
 *    derived from that key. Only after the user confirms the codes match here
 *    does this device encrypt and deposit the vault — never automatically.
 *
 * In every case the server only ever relays a blob it cannot read.
 */
export function SettingsLinkDeviceModal({ onClose }: Props) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [phase, setPhase] = useState<Phase>('gate')
  const [processing, setProcessing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Mode B state.
  const [qrValue, setQrValue] = useState<string | null>(null)
  const [verificationCode, setVerificationCode] = useState<string | null>(null)
  const pendingPubkeyRef = useRef<string | null>(null)
  const rendezvousIdRef = useRef<string | null>(null)
  const stopRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  useEffect(() => acquireBodyScrollLock(), [])

  const cleanupPolling = useCallback(() => {
    stopRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => cleanupPolling(), [cleanupPolling])

  // -------- Mode A: scan the QR shown by the new device --------
  async function handleScan(raw: string): Promise<boolean> {
    const payload = parseLinkQrPayload(raw)
    if (!payload) return false // not a Mode A device-link QR — keep scanning
    if (!user?.id) {
      setErr(explainDeviceLinkError('NOT_AUTHENTICATED', t))
      return true
    }

    setProcessing(true)
    setErr(null)
    try {
      const vaultBlob = readVaultBlob(user.id)
      if (!vaultBlob) throw new Error('VAULT_NOT_FOUND')
      const encBlob = await encryptVaultToEphemeralKey(
        JSON.stringify(vaultBlob),
        payload.ephemeralPubkey
      )
      await depositToRendezvous(payload.rendezvousId, encBlob)
      setPhase('done')
    } catch (e) {
      const message = e instanceof Error ? e.message : 'DEVICE_LINK_FAILED'
      setErr(explainDeviceLinkError(message, t))
    } finally {
      setProcessing(false)
    }
    return true // stop scanning whether we succeeded or errored
  }

  // -------- Mode B: show a QR, poll for the new device's key --------
  const startShowQr = useCallback(async () => {
    cleanupPolling()
    stopRef.current = false
    setErr(null)
    setQrValue(null)
    setVerificationCode(null)
    pendingPubkeyRef.current = null
    rendezvousIdRef.current = null
    setPhase('showqr')

    try {
      // Empty (Mode B) rendezvous — the new device submits its key later.
      const rdv = await createRendezvous()
      if (stopRef.current) return
      rendezvousIdRef.current = rdv.rendezvous_id
      setQrValue(buildLinkModeBQrPayload(rdv.rendezvous_id, rdv.claim_secret))

      const deadline = Date.now() + rdv.expires_in * 1000

      const poll = async (): Promise<void> => {
        if (stopRef.current) return
        if (Date.now() > deadline) {
          setErr(explainDeviceLinkError('INVALID_OR_EXPIRED_LINK_TOKEN', t))
          setPhase('mode')
          return
        }
        try {
          const status = await getRendezvousStatus(rdv.rendezvous_id)
          if (stopRef.current) return
          if (status.status === 'gone') {
            setErr(explainDeviceLinkError('INVALID_OR_EXPIRED_LINK_TOKEN', t))
            setPhase('mode')
            return
          }
          if (status.status === 'waiting') {
            timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
            return
          }
          // The new device submitted its ephemeral key. Derive the
          // verification code and STOP — the user must compare and confirm.
          pendingPubkeyRef.current = status.ephemeralPubkey
          const code = await deriveLinkVerificationCode(
            rdv.rendezvous_id,
            status.ephemeralPubkey
          )
          if (stopRef.current) return
          setVerificationCode(code)
          setPhase('verify')
        } catch {
          if (stopRef.current) return
          setErr(t('settings.linkShowFailed'))
          setPhase('mode')
        }
      }

      timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } catch {
      if (stopRef.current) return
      setErr(t('settings.linkShowFailed'))
      setPhase('mode')
    }
  }, [cleanupPolling, t])

  // -------- Mode B: explicit user confirmation -> encrypt + deposit --------
  const confirmAndDeposit = useCallback(async () => {
    const pubkey = pendingPubkeyRef.current
    const rid = rendezvousIdRef.current
    if (!pubkey || !rid || !user?.id) {
      setErr(explainDeviceLinkError('DEVICE_LINK_FAILED', t))
      return
    }
    setProcessing(true)
    setErr(null)
    try {
      const vaultBlob = readVaultBlob(user.id)
      if (!vaultBlob) throw new Error('VAULT_NOT_FOUND')
      const encBlob = await encryptVaultToEphemeralKey(
        JSON.stringify(vaultBlob),
        pubkey
      )
      await depositToRendezvous(rid, encBlob)
      cleanupPolling()
      setPhase('done')
    } catch (e) {
      const message = e instanceof Error ? e.message : 'DEVICE_LINK_FAILED'
      setErr(explainDeviceLinkError(message, t))
    } finally {
      setProcessing(false)
    }
  }, [cleanupPolling, t, user?.id])

  const handleClose = useCallback(() => {
    cleanupPolling()
    onClose()
  }, [cleanupPolling, onClose])

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

  const primaryButtonClass = `w-full border py-2 text-[10px] uppercase tracking-widest transition-colors ${
    isRetro
      ? 'p13-classic-button'
      : 'border-neon-cyan bg-void font-mono text-neon-cyan hover:bg-neon-cyan/10'
  }`

  return (
    <PortalRoot>
      <div
        className={`p13-settings-root custom-scrollbar fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto px-3 py-6 ${
          isMd3
            ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm'
            : isRetro
              ? 'p13-classic-overlay'
              : 'bg-void/92'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.linkDeviceTitle')}
      >
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className={`terminal-panel p13-dialog-panel p13-dialog-scroll custom-scrollbar my-auto flex w-full max-w-md flex-col p-4 ${
            isMd3
              ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
              : isRetro
                ? 'p13-classic-window'
                : 'border border-neon-cyan/40 bg-void'
          }`}
        >
          <div
            className={`flex items-start justify-between gap-2 border-b pb-3 ${
              isRetro ? 'p13-classic-titlebar px-2 pt-2' : 'border-neon-red/35'
            }`}
          >
            <p
              className={`min-w-0 break-words text-[10px] ${
                isMd3
                  ? 'text-[var(--on-surface)]'
                  : isRetro
                    ? 'tracking-[0.04em]'
                    : 'font-mono uppercase tracking-[0.25em] text-neon-cyan'
              }`}
            >
              {t('settings.linkDeviceTitle')}
            </p>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t('common.close')}
              title={t('common.close')}
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-all duration-200 ease-in-out active:scale-95 ${
                isRetro
                  ? 'p13-classic-button'
                  : 'text-neon-red hover:bg-neon-cyan/10 hover:text-neon-cyan'
              }`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {phase === 'gate' ? (
            <div className="mt-4">
              <VaultPinGate
                actionLabel={t('settings.linkReauthLabel')}
                onVerified={() => setPhase('mode')}
                onCancel={handleClose}
              />
            </div>
          ) : phase === 'done' ? (
            <div className="mt-4 flex flex-col items-center gap-4 py-6">
              <p className="text-center text-[10px] leading-relaxed text-neon-cyan">
                {t('settings.linkDone')}
              </p>
              <button
                type="button"
                onClick={handleClose}
                className={`w-full border py-2 text-[10px] uppercase tracking-widest transition-colors ${
                  isRetro
                    ? 'p13-classic-button'
                    : 'border-neon-cyan bg-void font-mono text-neon-cyan hover:bg-neon-cyan/10'
                }`}
              >
                [ OK ]
              </button>
            </div>
          ) : (
            <>
              <p
                className={`mt-3 break-words text-[9px] leading-relaxed ${
                  isRetro ? 'p13-classic-copy-soft' : 'text-text-muted/80'
                }`}
              >
                {t('settings.linkDeviceHint')}
              </p>

              {/* Mode toggle — available while choosing or in either flow. */}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    cleanupPolling()
                    setErr(null)
                    setPhase('scan')
                  }}
                  className={tabButtonClass(phase === 'scan')}
                >
                  {t('settings.linkModeScan')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (phase !== 'showqr' && phase !== 'verify') void startShowQr()
                  }}
                  className={tabButtonClass(phase === 'showqr' || phase === 'verify')}
                >
                  {t('settings.linkModeShow')}
                </button>
              </div>

              {phase === 'mode' && (
                <p
                  className={`mt-4 break-words text-[9px] leading-relaxed ${
                    isRetro ? 'p13-classic-copy' : 'text-neon-cyan/70'
                  }`}
                >
                  {t('settings.linkScanHint')}
                </p>
              )}

              {/* Mode A — scan */}
              {phase === 'scan' && (
                <>
                  <p
                    className={`mt-3 break-words text-[9px] leading-relaxed ${
                      isRetro ? 'p13-classic-copy' : 'text-neon-cyan/80'
                    }`}
                  >
                    {t('settings.linkScanHint')}
                  </p>
                  <div className="mt-4">
                    <QrScanner onScan={handleScan} processing={processing} isRetro={isRetro} />
                  </div>
                </>
              )}

              {/* Mode B — show QR, waiting for the new device */}
              {phase === 'showqr' && (
                <div className="mt-4 space-y-3">
                  <p
                    className={`break-words text-[9px] leading-relaxed ${
                      isRetro ? 'p13-classic-copy' : 'text-neon-cyan/80'
                    }`}
                  >
                    {t('settings.linkShowHint')}
                  </p>
                  {qrValue ? (
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
                  ) : (
                    <p className="py-6 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted">
                      [ ... ]
                    </p>
                  )}
                  <p className="text-center text-[9px] uppercase tracking-widest text-neon-cyan/80">
                    {t('settings.linkShowWaiting')}
                  </p>
                </div>
              )}

              {/* Mode B — verification code + explicit confirm */}
              {phase === 'verify' && verificationCode && (
                <div className="mt-4 space-y-3">
                  <p
                    className={`text-center text-[10px] uppercase tracking-widest ${
                      isRetro ? 'p13-classic-copy-strong' : 'text-neon-cyan'
                    }`}
                  >
                    {t('settings.linkVerifyTitle')}
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
                  <p
                    className={`break-words text-[9px] leading-relaxed ${
                      isRetro ? 'p13-classic-copy' : 'text-text-muted/80'
                    }`}
                  >
                    {t('settings.linkVerifyInstruction')}
                  </p>
                  <p className="break-words border border-neon-red/30 bg-neon-red/5 p-2 text-[9px] leading-relaxed text-neon-red">
                    [!] {t('settings.linkVerifyWarning')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void confirmAndDeposit()}
                    disabled={processing}
                    className={`${primaryButtonClass} disabled:opacity-50`}
                  >
                    {processing
                      ? t('settings.linkSending')
                      : `[ ${t('settings.linkConfirmCta')} ]`}
                  </button>
                </div>
              )}

              {err && (
                <p className="mt-3 break-all font-mono text-[10px] text-neon-red">
                  [!] {err}
                </p>
              )}
            </>
          )}
        </motion.div>
      </div>
    </PortalRoot>
  )
}

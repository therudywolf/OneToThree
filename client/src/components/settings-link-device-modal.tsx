'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
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
} from '@/lib/device-link-crypto'
import { depositToRendezvous } from '@/lib/api/device-rendezvous'

type Props = { onClose: () => void }
type Phase = 'gate' | 'scan' | 'done'

/**
 * Old (logged-in) device side of P2P device linking. After a vault-PIN
 * re-auth it scans the QR shown by the new device, encrypts the local
 * vault to that device's ephemeral public key, and deposits the ciphertext
 * — the server only ever relays a blob it cannot read.
 */
export function SettingsLinkDeviceModal({ onClose }: Props) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [phase, setPhase] = useState<Phase>('gate')
  const [processing, setProcessing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  useEffect(() => acquireBodyScrollLock(), [])

  async function handleScan(raw: string): Promise<boolean> {
    const payload = parseLinkQrPayload(raw)
    if (!payload) return false // not a device-link QR — keep scanning
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
              onClick={onClose}
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
                onVerified={() => setPhase('scan')}
                onCancel={onClose}
              />
            </div>
          ) : phase === 'done' ? (
            <div className="mt-4 flex flex-col items-center gap-4 py-6">
              <p className="text-center text-[10px] leading-relaxed text-neon-cyan">
                {t('settings.linkDone')}
              </p>
              <button
                type="button"
                onClick={onClose}
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
              <p
                className={`mt-2 break-words text-[9px] leading-relaxed ${
                  isRetro ? 'p13-classic-copy' : 'text-neon-cyan/80'
                }`}
              >
                {t('settings.linkScanHint')}
              </p>
              <div className="mt-4">
                <QrScanner onScan={handleScan} processing={processing} isRetro={isRetro} />
              </div>
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

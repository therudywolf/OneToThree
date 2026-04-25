'use client'

import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { buildQrLoginUrl, postQrGenerate } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'
import { VaultPinGate } from '@/components/vault-pin-gate'
import { useAuth } from '@/components/auth/auth-provider'
import { signMessageWithVaultPin } from '@/lib/vault-signing'
import { readVaultBlob } from '@/lib/vault'
import { useThemeStore } from '@/store/themeStore'
import { explainDeviceLinkError } from '@/lib/device-link-errors'

type Props = { onClose: () => void }

export function SettingsLinkDeviceModal({ onClose }: Props) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [verified, setVerified] = useState(false)
  const [vaultPin, setVaultPin] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const qrValue = linkToken ? buildQrLoginUrl(linkToken) : null
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  async function generateQr() {
    if (!user?.id || !vaultPin) return
    setLoading(true)
    setErr(null)
    try {
      const vaultBlob = readVaultBlob(user.id)
      if (!vaultBlob) throw new Error('VAULT_NOT_FOUND')

      const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
      const signature = await signMessageWithVaultPin(user.id, vaultPin, nonce)
      const payload: {
        nonce: string
        signature: string
        totp_code?: string
        vault_blob?: string
      } = {
        nonce,
        signature,
        vault_blob: JSON.stringify(vaultBlob),
      }
      const code = totpCode.trim().replace(/\D/g, '').slice(0, 6)
      if (code.length === 6) payload.totp_code = code

      const { link_token } = await postQrGenerate(payload)
      setLinkToken(link_token)
      setNeedsTotp(false)
      setErr(null)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'QR_GENERATE_FAILED'
      if (message === 'TOTP_REQUIRED') setNeedsTotp(true)
      else setErr(explainDeviceLinkError(message, t))
    } finally {
      setLoading(false)
    }
  }

  // Генерируем QR только после подтверждения vault-пароля.
  useEffect(() => {
    if (!verified || !vaultPin) return
    void generateQr()
  }, [verified, vaultPin])

  return (
    <div
      className={`fixed inset-0 z-[110] flex items-center justify-center px-3 py-6 ${
        isMd3 ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm' : isRetro ? 'p13-classic-overlay' : 'bg-void/92'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.linkDeviceTitle')}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className={`terminal-panel flex max-h-[min(90dvh,90vh)] w-full max-w-md flex-col overflow-hidden p-4 ${
          isMd3
            ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
          : isRetro
              ? 'p13-classic-window'
              : 'border border-neon-cyan/40 bg-void'
        }`}
      >
        <div className={`flex items-start justify-between gap-2 border-b pb-3 ${isRetro ? 'p13-classic-titlebar px-2 pt-2' : 'border-neon-red/35'}`}>
          <p className={`min-w-0 break-words text-[10px] ${isMd3 ? 'text-[var(--on-surface)]' : isRetro ? 'tracking-[0.04em]' : 'font-mono uppercase tracking-[0.25em] text-neon-cyan'}`}>
            {t('settings.linkDeviceTitle')}
          </p>
          <button
            type="button"
            onClick={onClose}
            className={`shrink-0 text-xs transition-all duration-200 ease-in-out active:scale-95 ${isRetro ? 'p13-classic-button px-2 py-0.5' : 'font-mono text-neon-red hover:text-neon-cyan'}`}
          >
            [X]
          </button>
        </div>

        {!verified ? (
          <div className="mt-4">
            <VaultPinGate
              actionLabel="Для генерации QR-кода привязки устройства требуется подтверждение vault-пароля."
              onVerified={(pin) => {
                setVaultPin(pin)
                setVerified(true)
              }}
              onCancel={onClose}
            />
          </div>
        ) : (
          <>
            <p className={`mt-3 break-words text-[9px] leading-relaxed ${isRetro ? 'p13-classic-copy-soft' : 'text-danger'}`}>
              {t('settings.linkDeviceHint')}
            </p>
            {needsTotp ? (
              <div className={`mt-3 p-3 ${isRetro ? 'p13-classic-inset' : 'border border-neon-cyan/30 bg-void/60'}`}>
                <p className={`mb-2 text-[9px] uppercase tracking-widest ${isRetro ? 'p13-classic-copy' : 'text-neon-cyan/80'}`}>
                  [ TOTP REQUIRED ]
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className={`w-full px-3 py-2 text-center text-xs tracking-[0.3em] placeholder:text-text-muted/70 focus:outline-none ${isRetro ? 'p13-classic-input p13-classic-copy' : 'border border-neon-cyan/30 bg-void font-mono text-neon-cyan focus:border-neon-cyan'}`}
                />
                <button
                  type="button"
                  onClick={() => void generateQr()}
                  disabled={loading || totpCode.replace(/\D/g, '').length !== 6}
                  className={`mt-2 w-full border py-2 text-[10px] uppercase tracking-widest transition-colors disabled:opacity-50 ${isRetro ? 'p13-classic-button' : 'border-neon-cyan bg-void font-mono text-neon-cyan hover:bg-neon-cyan/10'}`}
                >
                  [ RETRY WITH TOTP ]
                </button>
              </div>
            ) : null}
            <div className={`mt-4 flex min-h-[200px] flex-1 items-center justify-center p-4 ${isRetro ? 'p13-classic-inset' : 'border border-neon-cyan/25 bg-void'}`}>
              {loading ? (
                <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                  [ LOADING... ]
                </span>
              ) : err ? (
                <p className="break-all font-mono text-[10px] text-neon-red">[!] {err}</p>
              ) : qrValue ? (
                <QRCodeSVG
                  value={qrValue}
                  size={200}
                  bgColor="#000000"
                  fgColor="#22d3ee"
                  level="M"
                  className="max-w-full"
                />
              ) : null}
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}

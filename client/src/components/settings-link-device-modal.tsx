'use client'

import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { buildQrLoginUrl, postQrGenerate } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'
import { VaultPinGate } from '@/components/vault-pin-gate'
import { useAuth } from '@/components/auth/auth-provider'
import { signMessageWithVaultPin } from '@/lib/vault-signing'

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

  async function generateQr() {
    if (!user?.id || !vaultPin) return
    setLoading(true)
    setErr(null)
    try {
      const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
      const signature = await signMessageWithVaultPin(user.id, vaultPin, nonce)
      const payload: { nonce: string; signature: string; totp_code?: string } = {
        nonce,
        signature,
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
      if (message === 'DEVICE_LINKING_DISABLED') {
        setErr('DEVICE_LINKING_DISABLED :: Включите "Device Linking" в Security settings.')
      } else {
        setErr(message)
      }
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
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/92 px-3 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.linkDeviceTitle')}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="terminal-panel flex max-h-[min(90dvh,90vh)] w-full max-w-md flex-col overflow-hidden border border-neon-cyan/40 bg-black p-4"
      >
        <div className="flex items-start justify-between gap-2 border-b border-neon-red/35 pb-3">
          <p className="min-w-0 break-words font-mono text-[10px] uppercase tracking-[0.25em] text-neon-cyan">
            {t('settings.linkDeviceTitle')}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 font-mono text-xs text-neon-red transition-all duration-200 ease-in-out hover:text-neon-cyan active:scale-95"
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
            <p className="mt-3 break-words text-[9px] leading-relaxed text-red-800">
              {t('settings.linkDeviceHint')}
            </p>
            {needsTotp ? (
              <div className="mt-3 border border-neon-cyan/30 bg-zinc-950/60 p-3">
                <p className="mb-2 text-[9px] uppercase tracking-widest text-neon-cyan/80">
                  [ TOTP REQUIRED ]
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full border border-neon-cyan/30 bg-zinc-950 px-3 py-2 text-center font-mono text-xs tracking-[0.3em] text-neon-cyan placeholder:text-zinc-600 focus:border-neon-cyan focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void generateQr()}
                  disabled={loading || totpCode.replace(/\D/g, '').length !== 6}
                  className="mt-2 w-full border border-neon-cyan bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-50"
                >
                  [ RETRY WITH TOTP ]
                </button>
              </div>
            ) : null}
            <div className="mt-4 flex min-h-[200px] flex-1 items-center justify-center border border-neon-cyan/25 bg-black p-4">
              {loading ? (
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
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

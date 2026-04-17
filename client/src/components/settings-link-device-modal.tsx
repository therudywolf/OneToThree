'use client'

import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { buildQrLoginUrl, postQrGenerate } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'
import { VaultPinGate } from '@/components/vault-pin-gate'

type Props = { onClose: () => void }

export function SettingsLinkDeviceModal({ onClose }: Props) {
  const { t } = useTranslation()
  const [verified, setVerified] = useState(false)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const qrValue = linkToken ? buildQrLoginUrl(linkToken) : null

  // Генерируем QR только после подтверждения vault-пароля
  useEffect(() => {
    if (!verified) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      setErr(null)
      try {
        const { link_token } = await postQrGenerate()
        if (!cancelled) setLinkToken(link_token)
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : 'QR_GENERATE_FAILED')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [verified])

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
              onVerified={() => setVerified(true)}
              onCancel={onClose}
            />
          </div>
        ) : (
          <>
            <p className="mt-3 break-words text-[9px] leading-relaxed text-red-800">
              {t('settings.linkDeviceHint')}
            </p>
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

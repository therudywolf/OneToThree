'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { ensureClientDeviceId } from '@/lib/api/auth'
import { postQrLogin } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'

/**
 * New-device flow: paste token from QR (or scan → copy) after `ensureClientDeviceId`.
 */
export function LoginQrDevicePanel() {
  const { t } = useTranslation()
  const router = useRouter()
  const { refresh } = useAuth()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const raw = token.trim()
    if (raw.length < 32) {
      setErr(t('login.qrTokenInvalid'))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      ensureClientDeviceId()
      await postQrLogin(raw)
      await refresh()
      router.replace('/')
      router.refresh()
    } catch (e2) {
      setErr(
        e2 instanceof Error ? e2.message.replace(/_/g, ' ') : t('errors.generic')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-8 w-full max-w-md border border-neon-cyan/30 bg-black/60 px-4 py-3">
      <button
        type="button"
        data-testid="qr-link-toggle"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left font-mono text-[10px] uppercase tracking-[0.25em] text-neon-cyan hover:text-neon-red"
      >
        [ {open ? '−' : '+'} ] {t('login.qrLinkSection')}
      </button>
      {open ? (
        <form onSubmit={(e) => void onSubmit(e)} className="mt-3 space-y-2">
          <p className="text-[9px] leading-relaxed text-red-800">
            {t('login.qrLinkHint')}
          </p>
          <input
            data-testid="qr-token-input"
            className="terminal-input w-full text-xs"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('login.qrTokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('login.qrTokenPlaceholder')}
          />
          {err ? (
            <p className="font-mono text-[10px] text-neon-red">[!] {err}</p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="w-full border border-neon-cyan bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
          >
            [ {busy ? '…' : t('login.qrLinkSubmit')} ]
          </button>
        </form>
      ) : null}
    </div>
  )
}

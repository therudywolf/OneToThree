'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { postQrLogin } from '@/lib/api/auth-qr'
import { complete2faLogin } from '@/lib/api/auth'
import { useTranslation } from '@/hooks/use-translation'
import { explainDeviceLinkError } from '@/lib/device-link-errors'
import { explainLoginError } from '@/lib/login-errors'
import { useThemeStore } from '@/store/themeStore'

function QrLoginInner() {
  const { t } = useTranslation()
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('link_token')
  const didRun = useRef(false)
  const [status, setStatus] = useState<'pending' | 'totp' | 'ok' | 'error'>('pending')
  const [errorMsg, setErrorMsg] = useState('')
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [verifyingTotp, setVerifyingTotp] = useState(false)
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    if (!token) {
      setStatus('error')
      setErrorMsg(t('login.qrAuthInvalidLink'))
      return
    }

    void postQrLogin(token)
      .then((result) => {
        if (result.ok === 'needs_2fa') {
          setPendingToken(result.pendingToken)
          setStatus('totp')
          return
        }
        setStatus('ok')
        setTimeout(() => router.replace('/'), 1200)
      })
      .catch((err: unknown) => {
        setStatus('error')
        const code = err instanceof Error ? err.message : 'QR_LOGIN_FAILED'
        setErrorMsg(explainDeviceLinkError(code, t))
      })
  }, [token, router, t])

  async function submitTotp() {
    if (!pendingToken || verifyingTotp) return
    const code = totpCode.replace(/\D/g, '').slice(0, 6)
    if (code.length !== 6) {
      setErrorMsg(t('login.totpSixDigits'))
      return
    }
    setVerifyingTotp(true)
    setErrorMsg('')
    try {
      await complete2faLogin(pendingToken, code)
      setStatus('ok')
      setTimeout(() => router.replace('/'), 1200)
    } catch (err: unknown) {
      const codeText = err instanceof Error ? err.message : 'TOTP_VERIFY_FAILED'
      setErrorMsg(explainLoginError(codeText, t))
    } finally {
      setVerifyingTotp(false)
    }
  }

  return (
    <main className={`flex min-h-dvh flex-col items-center justify-center gap-4 px-6 py-8 ${
      isRetro ? 'bg-void font-["Tahoma"] text-text-primary' : 'bg-void font-mono text-text-primary'
    }`}>
      <div className={`text-[11px] ${isRetro ? 'tracking-[0.03em]' : 'uppercase tracking-[0.2em] text-text-muted'}`}>
        {t('login.qrLinkSection')}
      </div>

      {status === 'pending' && (
        <>
          <div className="animate-pulse text-sm">{t('login.qrAuthPending')}</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            {t('login.qrAuthPendingHint')}
          </div>
        </>
      )}

      {status === 'ok' && (
        <>
          <div className="text-base text-neon-cyan">{t('login.qrAuthSuccess')}</div>
          <div className="text-xs text-text-muted">{t('login.qrAuthRedirecting')}</div>
        </>
      )}

      {status === 'totp' && (
        <>
          <div className="text-base text-neon-cyan">{t('login.totpTitle')}</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            {t('login.totpDescription')}
          </div>
          <input
            className={`w-56 border px-4 py-3 text-center text-base tracking-[0.35em] outline-none ${
              isRetro
                ? 'border-border-strong bg-surface text-text-primary'
                : 'border-border-strong bg-surface text-text-primary'
            }`}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitTotp()
              }
            }}
            placeholder="000000"
            autoComplete="one-time-code"
          />
          <a
            href="#submit"
            className={`mt-4 border px-5 py-2 text-xs uppercase tracking-widest ${verifyingTotp ? 'opacity-60' : 'opacity-100'} ${
              isRetro
                ? 'border-border-strong bg-surface text-text-primary'
                : 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10'
            }`}
            onClick={(e) => {
              e.preventDefault()
              void submitTotp()
            }}
          >
            {verifyingTotp ? t('login.authLoading') : t('login.totpSubmit')}
          </a>
          {errorMsg ? <div className="max-w-sm text-center text-sm leading-relaxed text-neon-red">{errorMsg}</div> : null}
        </>
      )}

      {status === 'error' && (
        <>
          <div className="text-base text-neon-red">{t('login.qrAuthError')}</div>
          <div className="max-w-sm text-center text-sm leading-relaxed text-neon-red">{errorMsg}</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            {t('login.qrAuthRenewHint')}
          </div>
          <a
            href="/login"
            className={`mt-3 border px-5 py-2 text-xs uppercase tracking-widest ${
              isRetro
                ? 'border-border-strong bg-surface text-text-primary'
                : 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10'
            }`}
          >
            {t('login.signIn')}
          </a>
        </>
      )}
    </main>
  )
}

export default function QrLoginPage() {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  return (
    <Suspense
      fallback={
        <main className={`flex min-h-dvh items-center justify-center ${isRetro ? 'bg-void font-["Tahoma"] text-text-primary' : 'bg-void font-mono text-text-primary'}`}>
          {t('login.authLoading')}
        </main>
      }
    >
      <QrLoginInner />
    </Suspense>
  )
}

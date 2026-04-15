'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ensureClientDeviceId } from '@/lib/api/auth'

function QrLoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token')
  const didRun = useRef(false)
  const [status, setStatus] = useState<'pending' | 'ok' | 'error'>('pending')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    if (!token) {
      setStatus('error')
      setErrorMsg('INVALID_LINK — токен отсутствует')
      return
    }

    // Гарантируем что у нового браузера есть client_device_id до запроса
    const clientDeviceId = ensureClientDeviceId()

    fetch('/api/auth/qr-login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-client-device-id': clientDeviceId,
      },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus('ok')
          setTimeout(() => router.replace('/'), 1200)
        } else {
          const body = await res.json().catch(() => ({}))
          setStatus('error')
          const codeMap: Record<string, string> = {
            INVALID_OR_EXPIRED_TOKEN: 'QR-код истёк или уже использован. Попроси новый.',
            BANNED_USER: 'Аккаунт заблокирован.',
            DEVICE_REVOKED: 'Это устройство было отозвано.',
            CLIENT_DEVICE_ID_REQUIRED: 'Ошибка идентификации устройства — попробуй снова.',
          }
          setErrorMsg(codeMap[body?.error] ?? body?.error ?? `HTTP ${res.status}`)
        }
      })
      .catch(() => {
        setStatus('error')
        setErrorMsg('Нет соединения с сервером.')
      })
  }, [token, router])

  const s = {
    page: {
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      background: '#0a0a0a',
      color: '#00ffcc',
      gap: '1rem',
      padding: '2rem',
    },
    label: { fontSize: '0.65rem', letterSpacing: '0.2em', color: '#444', textTransform: 'uppercase' as const },
    ok: { fontSize: '1rem', color: '#00ff88' },
    err: { fontSize: '0.85rem', color: '#ff4444', maxWidth: '320px', textAlign: 'center' as const, lineHeight: 1.6 },
    hint: { fontSize: '0.7rem', color: '#555', maxWidth: '320px', textAlign: 'center' as const, lineHeight: 1.6, marginTop: '0.5rem' },
    link: {
      marginTop: '1.5rem',
      fontSize: '0.7rem',
      color: '#00ffcc',
      textDecoration: 'none',
      border: '1px solid #00ffcc',
      padding: '0.5rem 1.2rem',
      letterSpacing: '0.15em',
      textTransform: 'uppercase' as const,
    },
    spinner: { fontSize: '0.85rem', color: '#00ffcc', animation: 'pulse 1.5s infinite' },
  }

  return (
    <main style={s.page}>
      <div style={s.label}>QR :: DEVICE LINK</div>

      {status === 'pending' && (
        <>
          <div style={s.spinner}>[ АВТОРИЗАЦИЯ... ]</div>
          <div style={s.hint}>
            Этот браузер получает сессию от устройства, которое сгенерировало QR-код.
            Пароль не нужен — доверие делегировано через токен.
          </div>
        </>
      )}

      {status === 'ok' && (
        <>
          <div style={s.ok}>[ OK :: СЕССИЯ ПОЛУЧЕНА ]</div>
          <div style={s.hint}>Перенаправление на главную...</div>
        </>
      )}

      {status === 'error' && (
        <>
          <div style={{ fontSize: '1rem', color: '#ff4444' }}>[ ОШИБКА ]</div>
          <div style={s.err}>{errorMsg}</div>
          <div style={s.hint}>
            QR действителен 5 минут и одноразовый. Зайди в настройки → Устройства → Добавить устройство и сгенерируй новый.
          </div>
          <a href="/login" style={s.link}>[ НА ВХОД ]</a>
        </>
      )}
    </main>
  )
}

export default function QrLoginPage() {
  return (
    <Suspense>
      <QrLoginInner />
    </Suspense>
  )
}

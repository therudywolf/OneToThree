'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { postQrLogin } from '@/lib/api/auth-qr'
import { complete2faLogin } from '@/lib/api/auth'

function QrLoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token')
  const didRun = useRef(false)
  const [status, setStatus] = useState<'pending' | 'totp' | 'ok' | 'error'>('pending')
  const [errorMsg, setErrorMsg] = useState('')
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [verifyingTotp, setVerifyingTotp] = useState(false)

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    if (!token) {
      setStatus('error')
      setErrorMsg('INVALID_LINK — токен отсутствует')
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
        const codeMap: Record<string, string> = {
          INVALID_OR_EXPIRED_TOKEN: 'QR-код истёк или уже использован. Попроси новый.',
          BANNED_USER: 'Аккаунт заблокирован.',
          DEVICE_REVOKED: 'Это устройство было отозвано.',
          CLIENT_DEVICE_ID_REQUIRED: 'Ошибка идентификации устройства — попробуй снова.',
          TOTP_STATE_INVALID: 'На сервере повреждено состояние TOTP у этого аккаунта.',
          QR_LOGIN_FAILED: 'QR-вход не удался.',
        }
        setErrorMsg(codeMap[code] ?? 'Нет соединения с сервером.')
      })
  }, [token, router])

  async function submitTotp() {
    if (!pendingToken || verifyingTotp) return
    const code = totpCode.replace(/\D/g, '').slice(0, 6)
    if (code.length !== 6) {
      setErrorMsg('Введите ровно 6 цифр.')
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
      const codeMap: Record<string, string> = {
        INVALID_PENDING_TOKEN: 'Шаг подтверждения просрочен. Отсканируй QR заново.',
        TOTP_INVALID: 'Неверный или просроченный код.',
        TOTP_ALREADY_USED: 'Этот код уже использован. Дождись нового.',
        TOTP_NOT_CONFIGURED: 'На сервере не настроен TOTP для этого аккаунта.',
        CLIENT_DEVICE_ID_REQUIRED: 'Не удалось зарегистрировать это устройство.',
        DEVICE_REVOKED: 'Это устройство отозвано и не может войти.',
      }
      setErrorMsg(codeMap[codeText] ?? 'Ошибка проверки TOTP.')
    } finally {
      setVerifyingTotp(false)
    }
  }

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
    input: {
      width: '220px',
      padding: '0.75rem 1rem',
      background: '#111',
      color: '#00ffcc',
      border: '1px solid #00ffcc55',
      letterSpacing: '0.35em',
      textAlign: 'center' as const,
      fontFamily: 'monospace',
      fontSize: '1rem',
      outline: 'none',
    },
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

      {status === 'totp' && (
        <>
          <div style={s.ok}>[ TOTP :: ПОДТВЕРЖДЕНИЕ ]</div>
          <div style={s.hint}>
            Этот аккаунт защищён двухфакторной аутентификацией. Введи 6-значный код из приложения-аутентификатора.
          </div>
          <input
            style={s.input}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
          />
          <a
            href="#submit"
            style={{ ...s.link, opacity: verifyingTotp ? 0.6 : 1 }}
            onClick={(e) => {
              e.preventDefault()
              void submitTotp()
            }}
          >
            {verifyingTotp ? '[ ПРОВЕРКА... ]' : '[ ПОДТВЕРДИТЬ ]'}
          </a>
          {errorMsg ? <div style={s.err}>{errorMsg}</div> : null}
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

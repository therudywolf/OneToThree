'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { postQrLogin } from '@/lib/api/auth-qr'
import { complete2faLogin } from '@/lib/api/auth'
import { useThemeStore } from '@/store/themeStore'

function QrLoginInner() {
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

  return (
    <main className={`flex min-h-dvh flex-col items-center justify-center gap-4 px-6 py-8 ${
      isRetro ? 'bg-[#0e3f86] font-["Tahoma"] text-[#f4f7ff]' : 'bg-[#0a0a0a] font-mono text-neon-cyan'
    }`}>
      <div className={`text-[11px] ${isRetro ? 'tracking-[0.03em]' : 'uppercase tracking-[0.2em] text-text-muted'}`}>QR :: DEVICE LINK</div>

      {status === 'pending' && (
        <>
          <div className="animate-pulse text-sm">[ АВТОРИЗАЦИЯ... ]</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            Этот браузер получает сессию от устройства, которое сгенерировало QR-код.
            Пароль не нужен — доверие делегировано через токен. История и ключи
            сквозного шифрования на новом устройстве подтягиваются отдельно (см.
            настройки синхронизации и устройств).
          </div>
        </>
      )}

      {status === 'ok' && (
        <>
          <div className="text-base text-neon-cyan">[ OK :: СЕССИЯ ПОЛУЧЕНА ]</div>
          <div className="text-xs text-text-muted">Перенаправление на главную...</div>
        </>
      )}

      {status === 'totp' && (
        <>
          <div className="text-base text-neon-cyan">[ TOTP :: ПОДТВЕРЖДЕНИЕ ]</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            Этот аккаунт защищён двухфакторной аутентификацией. Введи 6-значный код из приложения-аутентификатора.
          </div>
          <input
            className={`w-56 border px-4 py-3 text-center text-base tracking-[0.35em] outline-none ${
              isRetro ? 'border-[#6f747c] bg-[#ffffff] text-[#15385f]' : 'border-neon-cyan/40 bg-[#111] text-neon-cyan'
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
              isRetro ? 'border-[#6f747c] bg-[#d4d0c8] text-[#15385f]' : 'border-neon-cyan text-neon-cyan'
            }`}
            onClick={(e) => {
              e.preventDefault()
              void submitTotp()
            }}
          >
            {verifyingTotp ? '[ ПРОВЕРКА... ]' : '[ ПОДТВЕРДИТЬ ]'}
          </a>
          {errorMsg ? <div className="max-w-sm text-center text-sm leading-relaxed text-neon-red">{errorMsg}</div> : null}
        </>
      )}

      {status === 'error' && (
        <>
          <div className="text-base text-neon-red">[ ОШИБКА ]</div>
          <div className="max-w-sm text-center text-sm leading-relaxed text-neon-red">{errorMsg}</div>
          <div className="max-w-sm text-center text-xs leading-relaxed text-text-muted">
            QR действителен 5 минут и одноразовый. Зайди в настройки → Устройства → Добавить устройство и сгенерируй новый.
          </div>
          <a href="/login" className={`mt-3 border px-5 py-2 text-xs uppercase tracking-widest ${isRetro ? 'border-[#6f747c] bg-[#d4d0c8] text-[#15385f]' : 'border-neon-cyan text-neon-cyan'}`}>[ НА ВХОД ]</a>
        </>
      )}
    </main>
  )
}

export default function QrLoginPage() {
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  return (
    <Suspense
      fallback={
        <main className={`flex min-h-dvh items-center justify-center ${isRetro ? 'bg-[#0e3f86] font-["Tahoma"] text-[#f4f7ff]' : 'bg-[#0a0a0a] font-mono text-neon-cyan'}`}>
          [ QR :: ЗАГРУЗКА... ]
        </main>
      }
    >
      <QrLoginInner />
    </Suspense>
  )
}

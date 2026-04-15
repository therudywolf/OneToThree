'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function QrLoginPage() {
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
      setErrorMsg('INVALID_LINK')
      return
    }

    const clientDeviceId = localStorage.getItem('client_device_id') ?? undefined

    fetch('/api/auth/qr-login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(clientDeviceId ? { 'x-client-device-id': clientDeviceId } : {}),
      },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus('ok')
          setTimeout(() => router.replace('/'), 800)
        } else {
          const body = await res.json().catch(() => ({}))
          setStatus('error')
          setErrorMsg(body?.error ?? `HTTP_${res.status}`)
        }
      })
      .catch(() => {
        setStatus('error')
        setErrorMsg('NETWORK_ERROR')
      })
  }, [token, router])

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'monospace',
        background: '#0a0a0a',
        color: '#00ffcc',
        gap: '1.2rem',
        padding: '2rem',
      }}
    >
      <div style={{ fontSize: '0.75rem', letterSpacing: '0.15em', color: '#555' }}>
        QR :: LOGIN
      </div>

      {status === 'pending' && (
        <div style={{ fontSize: '1rem', color: '#00ffcc' }}>[ АВТОРИЗАЦИЯ... ]</div>
      )}

      {status === 'ok' && (
        <div style={{ fontSize: '1rem', color: '#00ff88' }}>[ OK :: ПЕРЕНАПРАВЛЕНИЕ ]</div>
      )}

      {status === 'error' && (
        <>
          <div style={{ fontSize: '1rem', color: '#ff4444' }}>[ ОШИБКА ]</div>
          <div style={{ fontSize: '0.8rem', color: '#888' }}>{errorMsg}</div>
          <a
            href="/"
            style={{
              marginTop: '1rem',
              fontSize: '0.75rem',
              color: '#00ffcc',
              textDecoration: 'none',
              border: '1px solid #00ffcc',
              padding: '0.4rem 1rem',
              letterSpacing: '0.1em',
            }}
          >
            [ НА ГЛАВНУЮ ]
          </a>
        </>
      )}
    </main>
  )
}

'use client'

import { useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { readVaultBlob } from '@/lib/vault'

/**
 * Модальник после регистрации — предлагает сохранить резервный ключ.
 * Вызывается из login-form.tsx после успешного GENESIS.
 * onDismiss — закрыть без скачивания (пользователь берёт ответственность на себя).
 */
export function PostRegisterVaultPrompt({
  onDismiss,
}: {
  onDismiss: () => void
}) {
  const { user } = useAuth()
  const [exportState, setExportState] = useState<'idle' | 'done' | 'error'>('idle')

  function exportVault() {
    const userId = user?.id
    if (!userId) {
      setExportState('error')
      return
    }
    const blob = readVaultBlob(userId)
    if (!blob) {
      setExportState('error')
      return
    }
    const payload = JSON.stringify(
      { userId, vault: blob, exported_at: new Date().toISOString() },
      null,
      2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `13vault-${userId.slice(0, 8)}.key`
    a.click()
    URL.revokeObjectURL(url)
    setExportState('done')
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          maxWidth: '400px',
          width: '100%',
          border: '1px solid rgba(255,60,60,0.6)',
          background: '#0a0a0a',
          padding: '2rem',
          fontFamily: 'monospace',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: '#ff4444', textTransform: 'uppercase' }}>
          [ КРИТИЧНО :: РЕЗЕРВНАЯ КОПИЯ КЛЮЧА ]
        </div>

        <p style={{ fontSize: '0.8rem', color: '#ccc', lineHeight: 1.7 }}>
          Твой приватный ключ хранится <strong style={{ color: '#fff' }}>только в этом браузере</strong>.
          Сервер его не знает и восстановить не сможет.
        </p>

        <p style={{ fontSize: '0.75rem', color: '#888', lineHeight: 1.6 }}>
          Если потеряешь этот браузер или очистишь данные — аккаунт станет недоступен навсегда.
          Скачай резервную копию и сохрани в надёжном месте.
        </p>

        <p style={{ fontSize: '0.7rem', color: '#555', lineHeight: 1.5 }}>
          Файл зашифрован твоим vault-паролем. Без него он бесполезен для посторонних.
        </p>

        {exportState === 'done' && (
          <div
            style={{
              border: '1px solid rgba(0,255,204,0.35)',
              background: 'rgba(0,255,204,0.08)',
              color: '#a8fff1',
              fontSize: '0.72rem',
              lineHeight: 1.6,
              padding: '0.75rem',
            }}
          >
            Резервная копия выгружена. Проверь папку загрузок и только потом продолжай вход.
          </div>
        )}

        {exportState === 'error' && (
          <div
            style={{
              border: '1px solid rgba(255,68,68,0.4)',
              background: 'rgba(255,68,68,0.08)',
              color: '#ff9f9f',
              fontSize: '0.72rem',
              lineHeight: 1.6,
              padding: '0.75rem',
            }}
          >
            Не удалось собрать резервную копию. Не продолжай вход, пока не повторишь экспорт.
          </div>
        )}

        <button
          onClick={exportVault}
          style={{
            marginTop: '0.5rem',
            border: '1px solid #00ffcc',
            background: 'transparent',
            color: '#00ffcc',
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            padding: '0.75rem',
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,255,204,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          [ СКАЧАТЬ РЕЗЕРВНУЮ КОПИЮ ]
        </button>

        <button
          onClick={onDismiss}
          style={{
            border: '1px solid #00ffcc',
            background: exportState === 'done' ? 'rgba(0,255,204,0.08)' : 'transparent',
            color: '#00ffcc',
            fontFamily: 'monospace',
            fontSize: '0.72rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            padding: '0.7rem',
            cursor: 'pointer',
          }}
        >
          [ Я сохранил копию, продолжить ]
        </button>

        <button
          onClick={onDismiss}
          style={{
            border: '1px solid #333',
            background: 'transparent',
            color: '#555',
            fontFamily: 'monospace',
            fontSize: '0.65rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '0.5rem',
            cursor: 'pointer',
          }}
        >
          Я понимаю риск, пропустить
        </button>
      </div>
    </div>
  )
}

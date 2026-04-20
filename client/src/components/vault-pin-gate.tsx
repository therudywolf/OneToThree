'use client'

/**
 * VaultPinGate — встраиваемый блокировщик.
 * Рендерит форму ввода vault-пароля, вызывает onVerified() после успешного unwrap.
 * Используется везде где нужно подтверждение перед опасным действием.
 */

import { useState, useRef } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { readVaultBlob } from '@/lib/vault'
import { unwrapPrivateJwkWithPin } from '@/lib/vault'

type Props = {
  /** Текст над полем — что именно подтверждает пользователь */
  actionLabel: string
  onVerified: (pin: string) => void
  onCancel: () => void
}

export function VaultPinGate({ actionLabel, onVerified, onCancel }: Props) {
  const { user } = useAuth()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function verify() {
    if (!pin.trim() || busy) return
    setBusy(true)
    setError(null)

    try {
      const userId = user?.id
      if (!userId) throw new Error('NO_SESSION')

      const blob = readVaultBlob(userId)
      if (!blob) throw new Error('NO_LOCAL_VAULT')

      await unwrapPrivateJwkWithPin(blob, pin)
      // Успех — ключ расшифровался
      onVerified(pin)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (
        msg === 'NO_LOCAL_VAULT' ||
        msg.includes('decrypt') ||
        msg.includes('unwrap') ||
        msg.includes('OperationError')
      ) {
        setError(
          msg === 'NO_LOCAL_VAULT'
            ? 'Хранилище не найдено в этом браузере.'
            : 'Неверный vault-пароль.'
        )
      } else {
        setError(msg || 'VAULT_VERIFY_FAILED')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-neon-cyan/40 bg-void p-4 space-y-3 font-mono">
      <div>
        <p className="text-[9px] uppercase tracking-widest text-neon-cyan/80">
          [ ПОДТВЕРЖДЕНИЕ ЛИЧНОСТИ ]
        </p>
        <p className="mt-1 text-[9px] text-text-muted">{actionLabel}</p>
      </div>

      <input
        ref={inputRef}
        type="password"
        autoFocus
        autoComplete="current-password"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void verify() }}
        placeholder="vault-пароль"
        className="w-full border border-neon-cyan/30 bg-void px-3 py-2 text-[10px] text-neon-cyan placeholder-text-muted focus:border-neon-cyan focus:outline-none"
      />

      {error && (
        <p className="text-[9px] text-neon-red">[!] {error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void verify()}
          disabled={busy || !pin.trim()}
          className="flex-1 border border-neon-cyan bg-void px-3 py-1.5 text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40 transition-colors"
        >
          {busy ? '...' : '[ ПОДТВЕРДИТЬ ]'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 border border-border-strong bg-void px-3 py-1.5 text-[9px] uppercase tracking-widest text-text-muted hover:bg-elevated/30 transition-colors"
        >
          [ ОТМЕНА ]
        </button>
      </div>
    </div>
  )
}

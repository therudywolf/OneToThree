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
import { useThemeStore } from '@/store/themeStore'

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
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

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
    <div className={`p-4 space-y-3 ${
      isMd3
        ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface-variant)]'
        : isRetro
          ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
          : 'border border-neon-cyan/40 bg-void font-mono'
    }`}>
      <div>
        <p className={`text-[9px] ${isRetro ? 'tracking-[0.02em] text-[#0f2f4f]' : 'uppercase tracking-widest text-neon-cyan/80'}`}>
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
        className={`w-full px-3 py-2 text-[10px] placeholder-text-muted focus:outline-none ${
          isMd3
            ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
            : isRetro
              ? 'border border-[#6f747c] bg-[#ffffff] font-["Tahoma"] text-[#0f2f4f] shadow-[inset_1px_1px_0_#7b818a,inset_-1px_-1px_0_#f6f6f6]'
              : 'border border-neon-cyan/30 bg-void text-neon-cyan focus:border-neon-cyan'
        }`}
      />

      {error && (
        <p className="text-[9px] text-neon-red">[!] {error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void verify()}
          disabled={busy || !pin.trim()}
          className={`flex-1 border px-3 py-1.5 text-[9px] disabled:opacity-40 transition-colors ${
            isRetro
              ? 'border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] text-[#10243a] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
              : 'border-neon-cyan bg-void uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10'
          }`}
        >
          {busy ? '...' : '[ ПОДТВЕРДИТЬ ]'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`flex-1 border px-3 py-1.5 text-[9px] transition-colors ${
            isRetro
              ? 'border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] text-[#3f4752] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
              : 'border-border-strong bg-void uppercase tracking-widest text-text-muted hover:bg-elevated/30'
          }`}
        >
          [ ОТМЕНА ]
        </button>
      </div>
    </div>
  )
}

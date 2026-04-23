'use client'

import { useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { readVaultBlob } from '@/lib/vault'
import { useThemeStore } from '@/store/themeStore'

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
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
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
    <div className={`fixed inset-0 z-[120] flex items-center justify-center px-6 py-8 ${isMd3 ? 'bg-[color-mix(in_srgb,var(--void)_65%,transparent)] backdrop-blur-sm' : 'bg-black/85'}`}>
      <div className={`w-full max-w-md space-y-4 p-8 ${
        isMd3
          ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
          : isRetro
            ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
            : 'border border-neon-red/60 bg-[#0a0a0a] font-mono'
      }`}>
        <div className={`text-[11px] ${isMd3 ? 'text-[var(--on-surface)] tracking-normal' : isRetro ? 'tracking-[0.02em] text-[#0f2f4f]' : 'uppercase tracking-[0.2em] text-neon-red'}`}>
          [ КРИТИЧНО :: РЕЗЕРВНАЯ КОПИЯ КЛЮЧА ]
        </div>
        <p className="text-sm leading-relaxed text-text-muted">
          Твой приватный ключ хранится <strong className={isRetro ? 'text-[#0f2f4f]' : 'text-text-primary'}>только в этом браузере</strong>.
          Сервер его не знает и восстановить не сможет.
        </p>
        <p className="text-xs leading-relaxed text-text-muted">
          Если потеряешь этот браузер или очистишь данные — аккаунт станет недоступен навсегда.
          Скачай резервную копию и сохрани в надёжном месте.
        </p>
        <p className="text-[11px] leading-relaxed text-text-muted/80">
          Файл зашифрован твоим vault-паролем. Без него он бесполезен для посторонних.
        </p>
        {exportState === 'done' && (
          <div className="border border-neon-cyan/40 bg-neon-cyan/10 p-3 text-xs leading-relaxed text-neon-cyan">
            Резервная копия выгружена. Проверь папку загрузок и только потом продолжай вход.
          </div>
        )}
        {exportState === 'error' && (
          <div className="border border-neon-red/50 bg-neon-red/10 p-3 text-xs leading-relaxed text-neon-red">
            Не удалось собрать резервную копию. Не продолжай вход, пока не повторишь экспорт.
          </div>
        )}
        <button
          onClick={exportVault}
          className={`mt-2 w-full border px-3 py-3 text-xs transition-colors ${
            isRetro
              ? 'border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] text-[#123659] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
              : 'border-neon-cyan bg-transparent font-mono uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan/10'
          }`}
        >
          [ СКАЧАТЬ РЕЗЕРВНУЮ КОПИЮ ]
        </button>
        <button
          onClick={onDismiss}
          className={`w-full border px-3 py-2 text-xs ${
            isRetro
              ? 'border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] tracking-[0.02em] text-[#123659] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff]'
              : `border-neon-cyan font-mono uppercase tracking-wider text-neon-cyan ${exportState === 'done' ? 'bg-neon-cyan/10' : 'bg-transparent'}`
          }`}
        >
          [ Я сохранил копию, продолжить ]
        </button>
        <button
          onClick={onDismiss}
          className={`w-full border px-3 py-2 text-[11px] ${isRetro ? 'border-[#838892] bg-[#d4d0c8] font-["Tahoma"] text-[#3f4752]' : 'border-border-strong bg-transparent font-mono uppercase tracking-wider text-text-muted'}`}
        >
          Я понимаю риск, пропустить
        </button>
      </div>
    </div>
  )
}

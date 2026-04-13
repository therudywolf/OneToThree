'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { ensureClientDeviceId } from '@/lib/api/auth'
import { postQrLogin } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: NODE_LINKING_INTERFACE
 * Level: Authority Layer (Hardware Binding)
 * Vibe: Clinical Pure / Terminal Noir / Zero-Trust
 */

export function LoginQrDevicePanel() {
  const { t } = useTranslation()
  const router = useRouter()
  const { refresh } = useAuth()
  
  const [isExpanded, setIsExpanded] = useState(false)
  const [signalToken, setSignalToken] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [errorLog, setErrorLog] = useState<string | null>(null)

  const executeBinding = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = signalToken.trim()

    // Минимальный порог целостности токена
    if (raw.length < 32) {
      setErrorLog(t('login.qrTokenInvalid'))
      return
    }

    setIsBusy(true)
    setErrorLog(null)

    try {
      /** [1] Проверка идентификатора клиента */
      ensureClientDeviceId()
      
      /** [2] Трансляция сигнала входа */
      await postQrLogin(raw)
      
      /** [3] Реинициализация сессии */
      await refresh()
      
      router.replace('/')
      router.refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.replace(/_/g, ' ') : t('errors.generic')
      setErrorLog(`BIND_FAULT // ${msg.toUpperCase()}`)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="mt-8 w-full border border-neutral-900 bg-black/40 p-1 backdrop-blur-sm transition-all hover:border-neutral-800">
      <div className="border border-neutral-900 p-4">
        
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex w-full items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-colors hover:text-neon-red"
        >
          <span>{t('login.qrLinkSection')}</span>
          <span className="text-xs opacity-50">{isExpanded ? '[ − ]' : '[ + ]'}</span>
        </button>

        {isExpanded && (
          <form 
            onSubmit={(e) => void executeBinding(e)} 
            className="mt-6 space-y-4 animate-in fade-in slide-in-from-top-1"
          >
            <div className="space-y-2">
              <p className="text-[9px] leading-relaxed text-zinc-600 uppercase tracking-widest">
                // {t('login.qrLinkHint')}
              </p>
              
              <div className="relative">
                <input
                  type="text"
                  value={signalToken}
                  onChange={(e) => setSignalToken(e.target.value)}
                  placeholder={t('login.qrTokenPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-zinc-950 border border-neutral-900 p-3 font-mono text-xs text-white outline-none focus:border-neon-cyan/50 placeholder:text-zinc-800"
                />
                <div className="absolute bottom-0 left-0 h-[1px] w-0 bg-neon-cyan transition-all duration-500 group-focus-within:w-full" />
              </div>
            </div>

            {errorLog && (
              <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] text-neon-red uppercase tracking-widest">
                [!] {errorLog}
              </div>
            )}

            <button
              type="submit"
              disabled={isBusy || !signalToken.trim()}
              className="group relative w-full overflow-hidden border border-neon-cyan bg-black py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black disabled:opacity-20"
            >
              <span className="relative z-10">
                {isBusy ? ':: SYNCING_SIGNAL ::' : `>> ${t('login.qrLinkSubmit')}`}
              </span>
              <div className="absolute inset-0 z-0 opacity-0 transition-opacity group-hover:bg-neon-cyan group-hover:opacity-10" />
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
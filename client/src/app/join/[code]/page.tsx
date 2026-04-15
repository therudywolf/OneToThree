'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { useTranslation } from '@/hooks/use-translation'

/**
 * ONETOTHREE :: PACK_INTEGRATION_NODE
 * Level: Public Layer (Join Protocol)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export const dynamic = 'force-dynamic'

export default function JoinPackPage() {
  const { t } = useTranslation()
  const router = useRouter()
  const params = useParams()
  const code = typeof params?.code === 'string' ? params.code : ''
  const { user, loading } = useAuth()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (loading) return

    // [1] Проверка идентификации
    if (!user) {
      router.replace(`/login?code=${encodeURIComponent(code.trim())}`)
      return
    }

    // [2] Проверка целостности кода
    if (!code.trim()) {
      setErr('INVALID_INTEGRATION_CODE')
      return
    }

    let cancelled = false

    // [3] Выполнение протокола слияния (Join)
    void joinChatByInviteCode(code)
      .then(({ chat_id }) => {
        if (cancelled) return
        // Успех: узел интегрирован в сектор чата
        router.replace(`/?chat=${encodeURIComponent(chat_id)}`)
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'LINK_INTEGRATION_FAILED'
        setErr(msg)
      })

    return () => {
      cancelled = true
    }
  }, [loading, user, code, router])

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-zinc-950 px-4 font-mono">
      
      {/* BACKGROUND_EFFECT */}
      <div className="pointer-events-none absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-zinc-800 via-black to-black" />

      <div className="relative z-10 w-full max-w-sm border border-neutral-900 bg-black p-8 shadow-2xl">
        {/* HEADER_INDICATOR */}
        <header className="mb-6 border-b border-neutral-900 pb-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 ${err ? 'bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]' : 'animate-pulse bg-neon-cyan'}`} />
            <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-500">
              SYS.INTEGRATION // {err ? 'FAILURE' : 'WORKING'}
            </p>
          </div>
        </header>

        {err ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-[9px] uppercase tracking-widest text-neutral-600">ERROR_LOG:</p>
              <p className="text-xs leading-relaxed text-neon-red">
                {t('join.failed')}: {err}
              </p>
            </div>
            
            <Link
              href="/"
              className="group flex h-10 items-center justify-center border border-neon-cyan/30 px-6 text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan/10 hover:text-white"
            >
              [ {t('common.back')} ]
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center space-y-4">
            <p className="animate-pulse text-xs uppercase tracking-[0.3em] text-neon-cyan">
              {t('join.working')}...
            </p>
            <div className="h-[1px] w-12 bg-neutral-800" />
            <p className="text-[9px] text-zinc-700">PREPARING_STUB_CHANNELS</p>
          </div>
        )}

        {/* FOOTER_MARK */}
        <footer className="mt-8 pt-4 border-t border-neutral-900/50">
          <p className="text-center text-[8px] uppercase tracking-widest text-neutral-800">
            ONETOTHREE // One_To_Three
          </p>
        </footer>
      </div>
    </main>
  )
}
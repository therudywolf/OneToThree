'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { useTranslation } from '@/hooks/use-translation'

export function JoinPackClient({ code }: { code: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading } = useAuth()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (loading) return
    if (!user) {
      router.replace(`/login?code=${encodeURIComponent(code.trim())}`)
      return
    }
    if (!code.trim()) {
      setErr('INVALID_INTEGRATION_CODE')
      return
    }

    let cancelled = false
    void joinChatByInviteCode(code)
      .then(({ chat_id }) => {
        if (cancelled) return
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
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-void px-4 font-mono">
      <div className="pointer-events-none absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-elevated via-void to-void" />

      <div className="relative z-10 w-full max-w-sm border border-border-strong bg-void p-8 shadow-2xl">
        <header className="mb-6 border-b border-border-strong pb-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 ${err ? 'bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]' : 'animate-pulse bg-neon-cyan'}`} />
            <p className="text-[10px] uppercase tracking-[0.4em] text-text-muted">
              SYS.INTEGRATION // {err ? 'FAILURE' : 'WORKING'}
            </p>
          </div>
        </header>

        {err ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-[9px] uppercase tracking-widest text-text-muted/70">ERROR_LOG:</p>
              <p className="text-xs leading-relaxed text-neon-red">
                {t('join.failed')}: {err}
              </p>
            </div>
            <Link
              href="/"
              className="group flex h-10 items-center justify-center border border-neon-cyan/30 px-6 text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan/10 hover:text-text-primary"
            >
              [ {t('common.back')} ]
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center space-y-4">
            <p className="animate-pulse text-xs uppercase tracking-[0.3em] text-neon-cyan">
              {t('join.working')}...
            </p>
          </div>
        )}

        <footer className="mt-8 border-t border-border-strong/50 pt-4">
          <p className="text-center text-[8px] uppercase tracking-widest text-text-muted/50">
            ONETOTHREE // One_To_Three
          </p>
        </footer>
      </div>
    </main>
  )
}

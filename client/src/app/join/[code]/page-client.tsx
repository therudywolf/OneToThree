'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { useTranslation } from '@/hooks/use-translation'

export function JoinPackClient({ code }: { code: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading } = useAuth()
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // `?code=` wins over the path segment. The static export only contains
  // /join/_ (generateStaticParams), so a native deep link to /join/<code> has no
  // document to land on inside the Capacitor WebView — a query-based route on
  // the exported page is the form that actually resolves there. The path form
  // stays for the web build, which regenerates unknown params on demand.
  const inviteCode = (searchParams.get('code') ?? code).trim()

  useEffect(() => {
    if (loading) return
    if (!user) {
      router.replace(`/login?code=${encodeURIComponent(inviteCode)}`)
      return
    }
    if (!inviteCode || inviteCode === '_') {
      setErr('INVALID_INTEGRATION_CODE')
    }
  }, [loading, user, inviteCode, router])

  /**
   * Joining is a DELIBERATE act, never a side effect of opening a URL.
   *
   * This used to POST /join/<code> straight from the mount effect. /join/<code>
   * is a top-level GET navigation, so the Origin/CSRF allowlist does not apply —
   * the POST is issued by the app itself with a perfectly legitimate Origin.
   * That meant any page (or an `onetothree://chat?code=` link on Android) could
   * enrol a logged-in visitor into an attacker-controlled group with one tap:
   * the attacker learned their user id, username and ECDH public key and could
   * message them, bypassing the peer-approval gate, with no dialog ever shown.
   */
  const confirmJoin = () => {
    if (busy || !inviteCode) return
    setBusy(true)
    setErr(null)
    joinChatByInviteCode(inviteCode)
      .then(({ chat_id }) => {
        router.replace(`/?chat=${encodeURIComponent(chat_id)}`)
      })
      .catch((e) => {
        setBusy(false)
        setErr(e instanceof Error ? e.message : 'LINK_INTEGRATION_FAILED')
      })
  }

  const showConfirm = !loading && !!user && !err && !busy

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
        ) : showConfirm ? (
          <div className="space-y-5">
            <p className="text-xs uppercase tracking-[0.2em] text-neon-cyan">
              {t('join.confirmTitle')}
            </p>
            <p className="text-[10px] leading-relaxed text-text-muted">
              {t('join.confirmBody')}
            </p>
            <p className="break-all text-[10px] tracking-widest text-text-muted/70">
              {inviteCode}
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={confirmJoin}
                className="flex h-10 items-center justify-center border border-neon-cyan px-6 text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan/10 hover:text-text-primary"
              >
                [ {t('join.confirmAction')} ]
              </button>
              <Link
                href="/"
                className="flex h-10 items-center justify-center border border-border-strong px-6 text-[10px] uppercase tracking-[0.3em] text-text-muted transition-all hover:text-text-primary"
              >
                [ {t('common.cancel')} ]
              </Link>
            </div>
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

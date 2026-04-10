'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { joinChatByInviteCode } from '@/lib/api/chats'
import { useTranslation } from '@/hooks/use-translation'

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
    if (!user) {
      router.replace('/login')
      return
    }
    if (!code.trim()) {
      setErr('INVALID_CODE')
      return
    }
    let cancelled = false
    void joinChatByInviteCode(code)
      .then(({ chat_id }) => {
        if (cancelled) return
        router.replace(`/?chat=${encodeURIComponent(chat_id)}`)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'JOIN_FAILED')
      })
    return () => {
      cancelled = true
    }
  }, [loading, user, code, router])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-black px-4 font-mono text-neon-cyan">
      {err ? (
        <>
          <p className="mb-2 text-center text-sm text-neon-red">
            {t('join.failed')}: {err}
          </p>
          <Link
            href="/"
            className="text-[10px] uppercase tracking-widest text-neon-cyan/80 hover:text-neon-cyan"
          >
            {t('join.back')}
          </Link>
        </>
      ) : (
        <p className="text-xs uppercase tracking-widest">{t('join.working')}</p>
      )}
    </div>
  )
}

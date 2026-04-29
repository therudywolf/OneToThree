'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { fetchPackPreview, cloneStickerPack, type PackPreview } from '@/lib/api/stickers'
import { useTranslation } from '@/hooks/use-translation'

type Phase = 'loading' | 'ready' | 'adding' | 'done' | 'error'

export function StickerAddClient({ packId }: { packId: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [pack, setPack] = useState<PackPreview | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!/^[0-9a-f-]{36}$/.test(packId)) {
      setErrMsg(t('stickers.addNotFound'))
      setPhase('error')
      return
    }
    let cancelled = false
    fetchPackPreview(packId)
      .then((p) => {
        if (cancelled) return
        setPack(p)
        setPhase('ready')
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : ''
        setErrMsg(
          msg === 'PACK_NOT_PUBLIC'
            ? t('stickers.addNotPublic')
            : t('stickers.addNotFound')
        )
        setPhase('error')
      })
    return () => { cancelled = true }
  }, [packId, t])

  const handleAdd = async () => {
    if (!user || phase !== 'ready') return
    setPhase('adding')
    try {
      await cloneStickerPack(packId)
      setPhase('done')
      setTimeout(() => router.replace('/?tab=stickers'), 1500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      setErrMsg(msg || 'CLONE_PACK_FAILED')
      setPhase('error')
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-void px-4 font-mono">
      <div className="pointer-events-none absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-elevated via-void to-void" />

      <div className="relative z-10 w-full max-w-sm border border-border-strong bg-void p-8 shadow-2xl">
        <header className="mb-6 border-b border-border-strong pb-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${phase === 'error' ? 'bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]' : phase === 'done' ? 'bg-neon-green' : 'animate-pulse bg-neon-cyan'}`} />
            <p className="text-[10px] uppercase tracking-[0.4em] text-text-muted">
              {t('stickers.addTitle')}
            </p>
          </div>
        </header>

        {phase === 'loading' || authLoading ? (
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">…</p>
        ) : phase === 'error' ? (
          <div className="space-y-4">
            <p className="font-mono text-[11px] text-neon-red">{errMsg}</p>
            <Link
              href="/"
              className="block border border-neon-cyan/30 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan/70 hover:border-neon-cyan hover:text-neon-cyan transition-colors"
            >
              ← Back
            </Link>
          </div>
        ) : phase === 'done' ? (
          <p className="font-mono text-[11px] text-neon-cyan">{t('stickers.addedMine')}</p>
        ) : pack ? (
          <div className="space-y-6">
            <div>
              <p className="text-sm text-neon-cyan">{pack.title}</p>
              <p className="mt-1 font-mono text-[10px] text-text-muted">
                {t('stickers.addDesc')
                  .replace('{count}', String(pack.sticker_count))
                  .replace('{format}', pack.format.toUpperCase())}
              </p>
            </div>

            {user ? (
              <button
                type="button"
                disabled={phase === 'adding'}
                onClick={() => void handleAdd()}
                className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-50"
              >
                {phase === 'adding' ? t('stickers.adding') : t('stickers.addBtn')}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-text-muted">{t('stickers.addLoginRequired')}</p>
                <Link
                  href="/login"
                  className="block w-full border border-neon-cyan bg-void py-2 text-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  {t('stickers.addLoginBtn')}
                </Link>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </main>
  )
}

'use client'

import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { ChatApp } from '@/components/chat/chat-app'

/**
 * PROJECT 13 :: ACTIVE_SECTOR_ROOT
 * Level: Core Layer (Authenticated Sector)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

function ActiveSectorNode() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    // [1] ACCESS_GUARD :: Если личность не подтверждена, узел отбрасывается в шлюз входа
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  // [2] SIGNAL_PENDING :: Состояние ожидания синхронизации с ядром
  if (loading || !user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 font-mono">
        <div className="flex flex-col items-center gap-4">
          <div className="h-1 w-12 bg-neutral-900 overflow-hidden">
            <div className="h-full w-full bg-neon-cyan animate-pulse" />
          </div>
          <p className="text-[10px] uppercase tracking-[0.5em] text-neutral-600 animate-pulse">
            :: SYNCING_SIGNAL ::
          </p>
        </div>
      </div>
    )
  }

  // [3] SECTOR_READY :: Развертывание основного интерфейса коммуникации
  return <ChatApp userId={user.id} username={user.username} />
}

export function HomeClient() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black">
      <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.035] bg-[url('/noise.svg')]" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_top_left,rgba(0,255,255,0.08),transparent_34%),radial-gradient(circle_at_85%_12%,rgba(255,0,90,0.08),transparent_28%),linear-gradient(180deg,transparent,rgba(0,0,0,0.24))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-28 border-b border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent)]" />
      
      <Suspense fallback={
        <div className="flex min-h-screen items-center justify-center bg-black">
          <span className="h-1 w-1 bg-neon-cyan animate-ping" />
        </div>
      }>
        <ActiveSectorNode />
      </Suspense>

      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 hidden px-6 py-4 md:block">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between rounded-full border border-white/5 bg-black/25 px-4 py-2 backdrop-blur-md">
          <p className="text-[9px] uppercase tracking-[0.42em] text-zinc-500">
            Secure Node / Active Mesh
          </p>
          <div className="flex items-center gap-3 text-[9px] uppercase tracking-[0.32em] text-zinc-600">
            <span className="h-1.5 w-1.5 rounded-full bg-neon-cyan shadow-[0_0_10px_rgba(0,255,255,0.9)]" />
            <span>Encrypted Session</span>
          </div>
        </div>
      </header>

      <footer className="pointer-events-none fixed bottom-4 left-4 z-50">
        <p className="text-[8px] uppercase tracking-widest text-neutral-700 opacity-60">
          NODE_ACTIVE // SECTOR_013
        </p>
      </footer>
    </main>
  )
}

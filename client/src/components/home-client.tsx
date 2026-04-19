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
      <div className="flex min-h-screen flex-col items-center justify-center bg-void font-mono">
        <div className="flex flex-col items-center gap-4">
          <div className="h-1 w-12 bg-surface overflow-hidden">
            <div className="h-full w-full bg-neon-cyan animate-pulse" />
          </div>
          <p className="text-[10px] uppercase tracking-[0.5em] text-text-muted animate-pulse">
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
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-void">
        <span className="h-1 w-1 bg-neon-cyan animate-ping" />
      </div>
    }>
      <ActiveSectorNode />
    </Suspense>
  )
}

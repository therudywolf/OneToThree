'use client'

import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { ChatApp } from '@/components/chat/chat-app'

function HomeInner() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  if (loading || !user) {
    return <div className="min-h-screen bg-black" aria-hidden />
  }

  return <ChatApp userId={user.id} username={user.username} />
}

export function HomeClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" aria-hidden />}>
      <HomeInner />
    </Suspense>
  )
}

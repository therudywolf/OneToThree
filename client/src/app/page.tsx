import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getDevUserFromEnv } from '@/lib/auth/dev-user'
import { ChatApp } from '@/components/chat/chat-app'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const dev = getDevUserFromEnv()
  if (!dev) {
    redirect('/login')
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-black" aria-hidden />}>
      <ChatApp userId={dev.id} email={dev.email} />
    </Suspense>
  )
}

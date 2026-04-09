import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ChatApp } from '@/components/chat/chat-app'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-black" aria-hidden />}>
      <ChatApp userId={user.id} email={user.email ?? ''} />
    </Suspense>
  )
}

'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useChatStore } from '@/store/chatStore'

export function LogoutButton() {
  const router = useRouter()
  const supabase = createClient()
  const resetStore = useChatStore((s) => s.reset)

  async function handleLogout() {
    resetStore()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <TerminalGlitchButton type="button" onClick={handleLogout}>
      [ LOGOUT ]
    </TerminalGlitchButton>
  )
}

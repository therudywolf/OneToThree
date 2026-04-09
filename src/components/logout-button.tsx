'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

export function LogoutButton() {
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
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

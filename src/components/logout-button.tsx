'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useChatStore } from '@/store/chatStore'
import { useCallStore } from '@/store/callStore'

export function LogoutButton() {
  const router = useRouter()
  const supabase = createClient()
  const resetStore = useChatStore((s) => s.reset)
  const resetCallStore = useCallStore((s) => s.reset)

  async function handleLogout() {
    const callState = useCallStore.getState()
    callState.localStream?.getTracks().forEach((t) => t.stop())
    Object.values(callState.connections).forEach((c) => {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    })
    resetCallStore()
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

'use client'

import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useChatStore } from '@/store/chatStore'
import { useCallStore } from '@/store/callStore'

export function LogoutButton() {
  const router = useRouter()
  const { logout } = useAuth()
  const resetStore = useChatStore((s) => s.reset)
  const resetCallStore = useCallStore((s) => s.reset)

  async function handleLogout() {
    const callState = useCallStore.getState()
    callState.localStream?.getTracks().forEach((t) => t.stop())
    Object.values(callState.peerConnections).forEach((pc) => {
      try {
        pc.close()
      } catch {
        /* ignore */
      }
    })
    resetCallStore()
    resetStore()
    await logout()
    router.push('/login')
    router.refresh()
  }

  return (
    <TerminalGlitchButton type="button" onClick={() => void handleLogout()}>
      [ LOGOUT ]
    </TerminalGlitchButton>
  )
}

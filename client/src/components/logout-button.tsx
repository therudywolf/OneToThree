'use client'

import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useChatStore } from '@/store/chatStore'
import { useCallStore } from '@/store/callStore'
import { useTranslation } from '@/hooks/use-translation'

type LogoutProps = {
  /** Default: compact header label; `critical` uses long settings-style label + full width. */
  variant?: 'default' | 'critical'
  className?: string
}

export function LogoutButton({
  variant = 'default',
  className = '',
}: LogoutProps) {
  const { t } = useTranslation()
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

  const label =
    variant === 'critical' ? t('settings.logoutSystem') : t('common.logout')
  const critical =
    variant === 'critical'
      ? 'w-full !border-neon-red !px-3 !py-2.5 !text-[10px] !text-neon-red hover:!bg-neon-red/15'
      : 'min-h-11 px-4 md:min-h-0'

  return (
    <TerminalGlitchButton
      type="button"
      className={`${critical} ${className}`.trim()}
      onClick={() => void handleLogout()}
    >
      [ {label} ]
    </TerminalGlitchButton>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * PROJECT 13 :: SHELL_INTEGRATION_PROTOCOL
 * Level: OS Layer (PWA Deployment)
 * Vibe: Clinical Pure / Terminal Noir
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function useShellIntegration() {
  const [integrationEvent, setIntegrationEvent] = useState<BeforeInstallPromptEvent | null>(
    null
  )

  useEffect(() => {
    /** [SIGNAL_INTERCEPT] :: Перехват запроса на установку оболочки */
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setIntegrationEvent(e as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    
    return () =>
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  /** [EXECUTE_INTEGRATION] :: Запуск процесса развертывания нативного узла */
  const triggerIntegration = useCallback(async () => {
    if (!integrationEvent) return

    try {
      await integrationEvent.prompt()
      const { outcome } = await integrationEvent.userChoice
      
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`>> [SYS.PWA] INTEGRATION_OUTCOME: ${outcome.toUpperCase()}`)
      }
    } catch (err) {
      console.error('>> [SYS.PWA] INTEGRATION_FAULT:', err)
    } finally {
      setIntegrationEvent(null)
    }
  }, [integrationEvent])

  const purgeIntegration = useCallback(() => setIntegrationEvent(null), [])

  return {
    isInstallable: !!integrationEvent,
    triggerIntegration,
    purgeIntegration,
  }
}

export const usePwaInstall = useShellIntegration
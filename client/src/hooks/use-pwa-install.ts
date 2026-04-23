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
  const [isInstalled, setIsInstalled] = useState(false)

  useEffect(() => {
    /** [SIGNAL_INTERCEPT] :: Перехват запроса на установку оболочки */
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setIntegrationEvent(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setIsInstalled(true)
      try {
        localStorage.setItem('p13:pwa-installed', '1')
      } catch {
        /* ignore quota/storage errors */
      }
      setIntegrationEvent(null)
    }

    try {
      setIsInstalled(localStorage.getItem('p13:pwa-installed') === '1')
    } catch {
      setIsInstalled(false)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    
    return () =>
      {
        window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
        window.removeEventListener('appinstalled', onInstalled)
      }
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
    isInstallable: !!integrationEvent && !isInstalled,
    isInstalled,
    triggerIntegration,
    purgeIntegration,
  }
}

export const usePwaInstall = useShellIntegration
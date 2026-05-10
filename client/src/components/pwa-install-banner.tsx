'use client'

import { useEffect, useState } from 'react'
import { Download, Share2, X } from 'lucide-react'
import { usePwaInstall } from '@/hooks/use-pwa-install'
import { useTranslation } from '@/hooks/use-translation'
import { isIOSOrIPadOS } from '@/lib/ios'

const DISMISS_KEY = 'p13:pwa-install-banner-dismissed'

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return true
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true
}

function isIosSafariLike(): boolean {
  return isIOSOrIPadOS()
}

export function PwaInstallBanner() {
  const { t } = useTranslation()
  const { isInstallable: canNativeInstall, triggerIntegration: promptInstall, purgeIntegration: clearDeferred } = usePwaInstall()
  const [dismissed, setDismissed] = useState(true)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  if (!mounted || dismissed || isStandaloneDisplay()) return null

  const showIosHint = isIosSafariLike()
  const showAndroidDesktop = canNativeInstall && !showIosHint

  if (!showIosHint && !showAndroidDesktop) return null

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setDismissed(true)
    clearDeferred()
  }

  return (
    <div
      className="pointer-events-auto fixed bottom-0 left-0 right-0 z-[85] border-t border-neon-cyan/50 bg-void/95 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_32px_rgba(0,0,0,0.85)] backdrop-blur-sm md:px-6"
      role="region"
      aria-label={t('pwa.installAria')}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 items-start gap-2">
          {showIosHint ? (
            <Share2
              className="mt-0.5 h-5 w-5 shrink-0 text-neon-cyan"
              strokeWidth={1.5}
              aria-hidden
            />
          ) : (
            <Download
              className="mt-0.5 h-5 w-5 shrink-0 text-neon-cyan"
              strokeWidth={1.5}
              aria-hidden
            />
          )}
          <div className="min-w-0 font-mono text-[10px] uppercase leading-snug tracking-[0.2em] text-neon-cyan/90">
            {showIosHint ? (
              <>
                <span className="text-neon-red">{t('common.systemTag')}</span>{' '}
                {t('pwa.iosInstallPrefix')}{' '}
                <span className="text-neon-cyan">{t('pwa.shareAction')}</span> →{' '}
                <span className="text-neon-cyan">&quot;{t('pwa.addToHomeScreen')}&quot;</span>{' '}
                — {t('pwa.iosInstallSuffix')}
              </>
            ) : (
              <>
                <span className="text-neon-red">{t('common.systemTag')}</span>{' '}
                {t('pwa.nativeInstallHint')}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {!showIosHint ? (
            <button
              type="button"
              onClick={() => void promptInstall()}
              className="border border-neon-cyan bg-void px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan shadow-[0_0_12px_rgba(34,211,238,0.2)] hover:bg-neon-cyan/10"
            >
              [ {t('pwa.installAction')} ]
            </button>
          ) : null}
          <button
            type="button"
            onClick={dismiss}
            className="border border-danger/40 p-2 text-danger hover:border-neon-red hover:text-neon-red"
            aria-label={t('common.dismiss')}
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  )
}

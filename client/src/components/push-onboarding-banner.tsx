'use client'

import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

const DISMISS_KEY = 'p13:push-onboarding-dismissed'

export function PushOnboardingBanner() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    function sync() {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        setVisible(false)
        return
      }
      if (Notification.permission !== 'default') {
        setVisible(false)
        return
      }
      let dismissed = false
      try {
        dismissed = localStorage.getItem(DISMISS_KEY) === '1'
      } catch {
        dismissed = false
      }
      setVisible(!dismissed)
    }
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])

  if (!mounted || !visible) return null

  async function onEnable() {
    try {
      await Notification.requestPermission()
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  function onDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b border-neon-cyan/35 bg-zinc-950/90 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-neon-cyan/90 shadow-[inset_0_1px_0_rgba(34,211,238,0.15)]"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Bell className="h-4 w-4 shrink-0 text-neon-cyan" strokeWidth={1.5} />
        <span className="min-w-0 leading-snug">
          <span className="text-neon-red">[ SYSTEM ]</span>{' '}
          {t('pushOnboarding.banner')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void onEnable()}
          className="border border-neon-cyan px-3 py-1.5 text-[9px] tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
        >
          [ {t('pushOnboarding.enable')} ]
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="border border-red-900/70 p-1.5 text-red-800 hover:border-neon-red hover:text-neon-red"
          aria-label={t('common.dismiss')}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

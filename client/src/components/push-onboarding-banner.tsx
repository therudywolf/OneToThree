'use client'

import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import {
  supportsWebPush,
  supportsNativePush,
  getVapidPublicKey,
  subscribeUserPush,
  getExistingPushSubscription,
  getNotificationPermission,
} from '@/lib/push-subscription'
import { toastWarn } from '@/store/toastStore'

const DISMISS_KEY = 'p13:push-onboarding-dismissed'

export function PushOnboardingBanner() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setMounted(true)

    async function sync() {
      if (typeof window === 'undefined') { setVisible(false); return }
      // Browser does not support Web Push — hide the banner
      if (!supportsWebPush() && !supportsNativePush()) { setVisible(false); return }
      if (supportsWebPush() && !supportsNativePush() && !getVapidPublicKey()) { setVisible(false); return }

      const permission = await getNotificationPermission()
      // Already blocked — the banner is useless
      if (permission === 'denied') { setVisible(false); return }
      // Already have a real push subscription — no banner needed
      if (permission === 'granted') {
        if (supportsNativePush()) {
          const token = localStorage.getItem('p13:native_push_token')
          if (token) { setVisible(false); return }
        }
        const sub = await getExistingPushSubscription()
        if (sub) { setVisible(false); return }
      }

      let dismissed = false
      try { dismissed = localStorage.getItem(DISMISS_KEY) === '1' } catch { /* */ }
      setVisible(!dismissed)
    }

    void sync()
    const onFocus = () => void sync()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (!mounted || !visible) return null

  async function onEnable() {
    setBusy(true)
    try {
      // Full flow: permission -> register -> subscribe -> send subscription to server
      await subscribeUserPush()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'PUSH_ENABLE_FAILED'
      toastWarn(msg, { title: 'Push' })
    } finally {
      setBusy(false)
    }
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* */ }
    setVisible(false)
  }

  function onDismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* */ }
    setVisible(false)
  }

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b border-neon-cyan/35 bg-void/90 px-3 py-2 font-mono text-[11px] tracking-wide text-neon-cyan/90 shadow-[inset_0_1px_0_rgba(34,211,238,0.15)]"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Bell className="h-4 w-4 shrink-0 text-neon-cyan" strokeWidth={1.5} />
        <span className="min-w-0 leading-snug">
          {t('pushOnboarding.banner')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void onEnable()}
          disabled={busy}
          className="border border-neon-cyan px-3 py-1.5 text-[9px] tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '[ … ]' : `[ ${t('pushOnboarding.enable')} ]`}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="border border-danger/40 p-1.5 text-danger hover:border-neon-red hover:text-neon-red"
          aria-label={t('common.dismiss')}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

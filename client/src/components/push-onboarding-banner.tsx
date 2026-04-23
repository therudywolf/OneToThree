'use client'

import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import {
  supportsWebPush,
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
      // Браузер не поддерживает Web Push — прячем баннер
      if (!supportsWebPush() || !getVapidPublicKey()) { setVisible(false); return }

      const permission = await getNotificationPermission()
      // Уже blocked — баннер бесполезен
      if (permission === 'denied') { setVisible(false); return }
      // Уже есть реальная SW-подписка — баннер не нужен
      if (permission === 'granted') {
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
      // Полный цикл: permission → SW register → pushManager.subscribe → POST /push/subscribe
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
      className="flex shrink-0 items-center justify-between gap-3 border-b border-neon-cyan/35 bg-void/90 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-neon-cyan/90 shadow-[inset_0_1px_0_rgba(34,211,238,0.15)]"
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

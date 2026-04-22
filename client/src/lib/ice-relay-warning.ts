'use client'

import en from '@/locales/en'
import ru from '@/locales/ru'
import { lastIceFetchWasStunOnly } from '@/lib/ice-servers'
import { useLocaleStore } from '@/store/localeStore'
import { toastWarn } from '@/store/toastStore'

let stunOnlyWarningShown = false

/** One-time UX hint when ICE has no TURN relay (symmetric NAT may block calls). */
export function notifyIfIceStunOnlyOnce(): void {
  if (stunOnlyWarningShown) return
  if (!lastIceFetchWasStunOnly()) return
  stunOnlyWarningShown = true
  const mod = useLocaleStore.getState().module
  const d = mod === 'ru' ? ru : en
  toastWarn(d['call.iceRelayMissing'], {
    title: d['call.iceRelayTitle'],
    ttlMs: 14000,
  })
}

/** For tests / devtools. */
export function __resetIceRelayWarningForTests(): void {
  stunOnlyWarningShown = false
}

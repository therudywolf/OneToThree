'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import {
  getNotificationPermission,
  getVapidPublicKey,
  subscribeUserPush,
  unsubscribeUserPush,
} from '@/lib/push-subscription'

export function NotificationToggle({ userId }: { userId: string }) {
  const [permission, setPermission] =
    useState<NotificationPermission>('default')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const p = await getNotificationPermission()
    setPermission(p)
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        setEnabled(!!sub && p === 'granted')
      } catch {
        setEnabled(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const vapidOk = !!getVapidPublicKey()

  async function toggle() {
    setError(null)
    setBusy(true)
    try {
      if (enabled) {
        await unsubscribeUserPush(userId)
        setEnabled(false)
      } else {
        if (!vapidOk) {
          setError('VAPID not configured')
          return
        }
        await subscribeUserPush(userId)
        setEnabled(true)
      }
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'NOTIFICATION_DENIED') {
        setError('Notifications blocked in browser settings')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const needsAttention = permission !== 'granted' && permission !== 'denied'

  return (
    <div
      className={`border-b border-neon-cyan/40 p-3 ${
        needsAttention ? 'animate-neon-pulse' : ''
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan">
          :: NOTIFY
        </span>
        {enabled ? (
          <Bell className="h-4 w-4 text-neon-cyan" aria-hidden />
        ) : (
          <BellOff className="h-4 w-4 text-red-800" aria-hidden />
        )}
      </div>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy || !vapidOk || permission === 'denied'}
        className="w-full rounded-none border border-neon-cyan/60 bg-black py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red disabled:cursor-not-allowed disabled:opacity-40"
      >
        {enabled ? '[ disable push ]' : '[ enable push ]'}
      </button>
      {!vapidOk ? (
        <p className="mt-1 text-[9px] text-red-800">VAPID_PUBLIC_KEY missing</p>
      ) : null}
      {permission === 'denied' ? (
        <p className="mt-1 text-[9px] text-red-800">
          Enable notifications in the browser for this site.
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-[9px] text-neon-red">{error}</p>
      ) : null}
    </div>
  )
}

/**
 * Web Push: subscribe in the browser and persist PushSubscription JSON to Supabase.
 * Requires NEXT_PUBLIC_VAPID_PUBLIC_KEY (URL-safe base64, no padding issues handled below).
 */

import { createClient } from '@/lib/supabase/client'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export function getVapidPublicKey(): string | undefined {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
}

export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  return Notification.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  if (Notification.permission === 'granted') {
    return 'granted'
  }
  return Notification.requestPermission()
}

export async function subscribeUserPush(userId: string): Promise<void> {
  const vapid = getVapidPublicKey()
  if (!vapid) {
    throw new Error('NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set')
  }

  const permission = await requestNotificationPermission()
  if (permission !== 'granted') {
    throw new Error('NOTIFICATION_DENIED')
  }

  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
  })

  const supabase = createClient()
  const json = sub.toJSON()
  if (!json?.endpoint || !json.keys) {
    throw new Error('INVALID_SUBSCRIPTION')
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      subscription: json,
      user_agent:
        typeof navigator !== 'undefined' ? navigator.userAgent : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )

  if (error) throw error
}

export async function unsubscribeUserPush(userId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await sub.unsubscribe()
  }

  const supabase = createClient()
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)

  if (error) throw error
}

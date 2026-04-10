/**
 * Web Push in the browser; subscriptions are stored via Fastify `/api/push/*`.
 */

import { API_URL } from '@/lib/api/auth'

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

async function postSubscribeToApi(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) {
    throw new Error('INVALID_PUSH_SUBSCRIPTION')
  }
  const res = await fetch(`${API_URL}/push/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: j.endpoint,
      keys: { p256dh: j.keys.p256dh, auth: j.keys.auth },
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PUSH_SUBSCRIBE_FAILED')
  }
}

async function deleteSubscribeFromApi(endpoint: string): Promise<void> {
  const res = await fetch(`${API_URL}/push/unsubscribe`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PUSH_UNSUBSCRIBE_FAILED')
  }
}

export async function subscribeUserPush(_userId: string): Promise<void> {
  void _userId
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
  await postSubscribeToApi(sub)
}

export async function unsubscribeUserPush(_userId: string): Promise<void> {
  void _userId
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) {
    return
  }
  const j = sub.toJSON()
  if (j.endpoint) {
    try {
      await deleteSubscribeFromApi(j.endpoint)
    } catch {
      /* still try browser unsubscribe */
    }
  }
  await sub.unsubscribe()
}

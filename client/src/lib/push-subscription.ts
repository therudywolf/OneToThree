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

/** Log once when push UI mounts if the build is missing the public VAPID key. */
export function warnIfVapidPublicKeyMissing(): void {
  if (typeof window === 'undefined') return
  if (!getVapidPublicKey()) {
    console.warn(
      '[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing — enable push is disabled until the client is built with this env var.'
    )
  }
}

export function supportsWebPush(): boolean {
  if (typeof window === 'undefined') return false
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
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

/** Read subscription without registering a service worker (for settings UI state). */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!supportsWebPush()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return null
    return await reg.pushManager.getSubscription()
  } catch (e) {
    console.error('[push] getExistingPushSubscription failed', e)
    return null
  }
}

/**
 * Ensure we have a service worker registration (next-pwa serves `/sw.js` in production).
 * Without this, `navigator.serviceWorker.ready` can hang forever if no SW was ever registered.
 */
export async function getServiceWorkerRegistrationForPush(): Promise<ServiceWorkerRegistration> {
  if (!supportsWebPush()) {
    throw new Error('WEB_PUSH_UNSUPPORTED')
  }
  let reg = await navigator.serviceWorker.getRegistration()
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      })
    } catch (e) {
      console.error('[push] Service worker registration failed (/sw.js)', e)
      throw new Error('SERVICE_WORKER_REGISTER_FAILED')
    }
  } else {
    await reg.update().catch((e) => {
      console.error('[push] serviceWorker.update() failed', e)
    })
  }
  await navigator.serviceWorker.ready
  return reg
}

async function postSubscribeToApi(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) {
    console.error('[push] Invalid PushSubscription JSON from browser', j)
    throw new Error('INVALID_PUSH_SUBSCRIPTION')
  }
  try {
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
      console.error('[push] POST /api/push/subscribe failed', res.status, data)
      throw new Error(data.error ?? 'PUSH_SUBSCRIBE_FAILED')
    }
  } catch (e) {
    console.error('[push] postSubscribeToApi failed', e)
    throw e
  }
}

async function deleteSubscribeFromApi(endpoint: string): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/push/unsubscribe`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      console.error('[push] DELETE /api/push/unsubscribe failed', res.status, data)
      throw new Error(data.error ?? 'PUSH_UNSUBSCRIBE_FAILED')
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('PUSH_')) {
      throw e
    }
    console.error('[push] deleteSubscribeFromApi error', e)
    throw e
  }
}

export async function subscribeUserPush(_userId: string): Promise<void> {
  void _userId
  const vapid = getVapidPublicKey()
  if (!vapid) {
    console.error('[push] subscribeUserPush: NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set')
    throw new Error('NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set')
  }
  if (!supportsWebPush()) {
    console.error('[push] subscribeUserPush: Web Push APIs unavailable')
    throw new Error('WEB_PUSH_UNSUPPORTED')
  }

  try {
    const permission = await requestNotificationPermission()
    if (permission !== 'granted') {
      console.warn('[push] Notification permission not granted:', permission)
      throw new Error('NOTIFICATION_DENIED')
    }

    const reg = await getServiceWorkerRegistrationForPush()
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
    })
    await postSubscribeToApi(sub)
  } catch (e) {
    if (e instanceof Error && e.message === 'NOTIFICATION_DENIED') {
      /* user dismissed prompt — avoid noisy error */
    } else {
      console.error('[push] subscribeUserPush failed', e)
    }
    throw e
  }
}

export async function unsubscribeUserPush(_userId: string): Promise<void> {
  void _userId
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return
    const sub = await reg.pushManager.getSubscription()
    if (!sub) {
      return
    }
    const j = sub.toJSON()
    if (j.endpoint) {
      try {
        await deleteSubscribeFromApi(j.endpoint)
      } catch (e) {
        console.error('[push] Server unsubscribe failed; continuing with browser unsubscribe', e)
      }
    }
    await sub.unsubscribe()
  } catch (e) {
    console.error('[push] unsubscribeUserPush failed', e)
    throw e
  }
}

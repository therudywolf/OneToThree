/**
 * PROJECT 13 :: PUSH_INTERCEPT_PROTOCOL
 * Level: Connection Layer (OS Alerts)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { API_URL } from '@/lib/api/auth'

/** [SIGNAL_ENCODING] :: Подготовка VAPID-ключа для браузерного PushManager */
function toUint8(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  const base = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base)
  return new Uint8Array(Array.from(raw, (c) => c.charCodeAt(0)))
}

export const getSignalKey = () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

/** [WARN_LOG] :: Проверка наличия ключа в сборке */
export function validateVapidSignal(): void {
  if (typeof window !== 'undefined' && !getSignalKey()) {
    console.warn('>> [SYS.PUSH] VAPID_KEY_MISSING. Intercept protocol disabled.')
  }
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** [AUTH_PROBE] :: Проверка текущих прав на прерывание */
export async function getInterceptAuthority(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
  return Notification.permission
}

export async function requestInterceptAuthority(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

/** [SCAN] :: Поиск существующего перехвата без регистрации нового SW */
export async function getActiveIntercept(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    return reg ? await reg.pushManager.getSubscription() : null
  } catch (err) {
    console.error('>> [SYS.PUSH] SCAN_FAULT:', err)
    return null
  }
}

/** [SW_INITIALIZE] :: Подготовка оболочки для приема сигналов */
export async function initPushWorker(): Promise<ServiceWorkerRegistration> {
  if (!isPushSupported()) throw new Error('WEB_PUSH_UNSUPPORTED')

  let reg = await navigator.serviceWorker.getRegistration()
  
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      })
    } catch (err) {
      console.error('>> [SYS.PUSH] WORKER_GENESIS_FAULT:', err)
      throw new Error('SERVICE_WORKER_REGISTER_FAILED')
    }
  } else {
    // Принудительное обновление для синхронизации слоев
    await reg.update().catch(() => {})
  }

  await navigator.serviceWorker.ready
  return reg
}

/** [SYNC_CORE] :: Передача данных перехвата на основной сервер */
async function syncInterceptWithCore(sub: PushSubscription): Promise<void> {
  const data = sub.toJSON()
  if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth) {
    throw new Error('INVALID_PUSH_DATA')
  }

  const res = await fetch(`${API_URL}/push/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: data.endpoint,
      keys: { p256dh: data.keys.p256dh, auth: data.keys.auth },
    }),
  })

  if (!res.ok) {
    const fault = await res.json().catch(() => ({}))
    throw new Error(fault.error ?? 'PUSH_SYNC_FAILED')
  }
}

/** [ESTABLISH_INTERCEPT] :: Полный цикл активации оповещений */
export async function establishPushIntercept(): Promise<void> {
  const vapid = getSignalKey()
  if (!vapid || !isPushSupported()) throw new Error('SIGNAL_HARDWARE_FAULT')

  try {
    const authority = await requestInterceptAuthority()
    if (authority !== 'granted') throw new Error('AUTHORITY_DENIED')

    const reg = await initPushWorker()
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toUint8(vapid),
    })

    await syncInterceptWithCore(sub)
  } catch (err) {
    if (!(err instanceof Error && err.message === 'AUTHORITY_DENIED')) {
      console.error('>> [SYS.PUSH] INTERCEPT_ESTABLISH_FAULT:', err)
    }
    throw err
  }
}

/** [TERMINATE_INTERCEPT] :: Удаление узла из системы оповещений */
export async function terminatePushIntercept(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return

    const sub = await reg.pushManager.getSubscription()
    if (!sub) return

    const endpoint = sub.toJSON().endpoint
    if (endpoint) {
      // Пытаемся уведомить сервер (Best-effort)
      await fetch(`${API_URL}/push/unsubscribe`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {})
    }

    await sub.unsubscribe()
  } catch (err) {
    console.error('>> [SYS.PUSH] TERMINATE_FAULT:', err)
    throw err
  }
}
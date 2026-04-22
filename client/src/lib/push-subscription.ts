/**
 * PROJECT 13 :: PUSH_INTERCEPT_PROTOCOL
 * Level: Connection Layer (OS Alerts)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { API_URL } from '@/lib/api/auth'

const RETRY_DELAYS_MS = [250, 800, 1600] as const

type PushHttpError = Error & { status?: number }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

function shouldRetryPushError(err: unknown): boolean {
  const status =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number'
      ? ((err as { status: number }).status)
      : null
  if (status !== null) {
    return isRetryablePushHttpStatus(status)
  }
  const msg = err instanceof Error ? err.message : ''
  if (!msg) return true
  if (
    msg === 'WEB_PUSH_UNSUPPORTED' ||
    msg === 'NOTIFICATION_DENIED' ||
    msg === 'INVALID_PUSH_DATA'
  ) {
    return false
  }
  return true
}

export function isRetryablePushHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function withRetry<T>(
  action: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean = shouldRetryPushError
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await action()
    } catch (err) {
      lastErr = err
      if (i >= RETRY_DELAYS_MS.length || !shouldRetry(err)) {
        throw err
      }
      await wait(RETRY_DELAYS_MS[i]!)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('RETRY_EXHAUSTED')
}

/** [SIGNAL_ENCODING] :: Подготовка VAPID-ключа для браузерного PushManager */
function toUint8(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  const base = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base)
  return new Uint8Array(Array.from(raw, (c) => c.charCodeAt(0)))
}

export const getVapidPublicKey = () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

/** [WARN_LOG] :: Проверка наличия ключа в сборке */
export function warnIfVapidPublicKeyMissing(): void {
  if (typeof window !== 'undefined' && !getVapidPublicKey()) {
    console.warn('>> [SYS.PUSH] VAPID_KEY_MISSING. Intercept protocol disabled.')
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

/** [AUTH_PROBE] :: Проверка текущих прав на прерывание */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
  return Notification.permission
}

export async function requestInterceptAuthority(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

/** [SCAN] :: Поиск существующего перехвата без регистрации нового SW */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!supportsWebPush()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    return reg ? await reg.pushManager.getSubscription() : null
  } catch (err) {
    console.error('>> [SYS.PUSH] SCAN_FAULT:', err)
    return null
  }
}

/**
 * [SW_INITIALIZE] :: Подготовка оболочки для приема сигналов.
 * ВАЖНО: файл push-handler.js должен лежать в client/public/push-handler.js
 */
export async function initPushWorker(): Promise<ServiceWorkerRegistration> {
  if (!supportsWebPush()) throw new Error('WEB_PUSH_UNSUPPORTED')

  // Ищем уже активный SW на scope '/'
  let reg = await navigator.serviceWorker.getRegistration('/')

  if (!reg) {
    try {
      // next-pwa registers /sw.js; it imports /push-handler.js (see next.config.js).
      // Registering /push-handler.js directly creates parallel workers and unstable push behavior.
      reg = await withRetry(() =>
        navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        })
      )
    } catch (err) {
      console.warn('>> [SYS.PUSH] /sw.js registration failed, trying legacy push-handler.js', err)
      try {
        reg = await withRetry(() =>
          navigator.serviceWorker.register('/push-handler.js', {
            scope: '/',
            updateViaCache: 'none',
          })
        )
      } catch (legacyErr) {
        console.error('>> [SYS.PUSH] WORKER_GENESIS_FAULT:', legacyErr)
        throw new Error('SERVICE_WORKER_REGISTER_FAILED')
      }
    }
  } else if (reg) {
    // Принудительное обновление для синхронизации слоев
    const existingReg = reg
    await withRetry(() => existingReg.update()).catch(() => {})
  }

  if (!reg) {
    throw new Error('SERVICE_WORKER_REGISTER_FAILED')
  }

  await navigator.serviceWorker.ready
  return reg
}

async function parsePushFault(res: Response): Promise<{ error?: string }> {
  return res.json().catch(() => ({})) as Promise<{ error?: string }>
}

async function requestPushSync(path: '/push/subscribe' | '/push/unsubscribe', init: RequestInit): Promise<void> {
  await withRetry(async () => {
    const res = await fetch(`${API_URL}${path}`, init)
    if (res.ok) return

    const fault = await parsePushFault(res)
    const err = new Error(fault.error ?? `PUSH_REQUEST_FAILED_${res.status}`) as PushHttpError
    err.status = res.status
    throw err
  })
}

/** [SYNC_CORE] :: Передача данных перехвата на основной сервер */
async function syncInterceptWithCore(sub: PushSubscription): Promise<void> {
  const data = sub.toJSON()
  if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth) {
    throw new Error('INVALID_PUSH_DATA')
  }
  const keys = data.keys

  await requestPushSync('/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: data.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      }),
    })
}

/** [ESTABLISH_INTERCEPT] :: Полный цикл активации оповещений */
export async function subscribeUserPush(): Promise<void> {
  const vapid = getVapidPublicKey()
  if (!vapid) throw new Error('WEB_PUSH_UNSUPPORTED')
  if (!supportsWebPush()) throw new Error('WEB_PUSH_UNSUPPORTED')

  const authority = await requestInterceptAuthority()
  if (authority !== 'granted') throw new Error('NOTIFICATION_DENIED')

  const reg = await initPushWorker()

  // Если уже есть подписка — переиспользуем, просто синхронизируем с сервером
  let sub = await reg.pushManager.getSubscription()

  if (!sub) {
    sub = await withRetry(() =>
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toUint8(vapid) as BufferSource,
      })
    )
  }

  await syncInterceptWithCore(sub)
}

/** [TERMINATE_INTERCEPT] :: Удаление узла из системы оповещений */
export async function unsubscribeUserPush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    if (!reg) return

    const sub = await reg.pushManager.getSubscription()
    if (!sub) return

    const endpoint = sub.toJSON().endpoint
    if (endpoint) {
      await requestPushSync('/push/unsubscribe', {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {})
    }

    await withRetry(() => sub.unsubscribe())
  } catch (err) {
    console.error('>> [SYS.PUSH] TERMINATE_FAULT:', err)
    throw err
  }
}

export const __testOnly = {
  requestPushSync,
  shouldRetryPushError,
}

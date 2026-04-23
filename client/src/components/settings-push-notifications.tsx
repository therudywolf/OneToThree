'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import {
  getStoredNotificationMode,
  getExistingPushSubscription,
  getDirectForegroundModeState,
  getNotificationPermission,
  getVapidPublicKey,
  setNotificationMode,
  supportsDirectForegroundMode,
  supportsNativePush,
  subscribeUserPush,
  supportsWebPush,
  unsubscribeUserPush,
  warnIfVapidPublicKeyMissing,
} from '@/lib/push-subscription'
import { useTranslation } from '@/hooks/use-translation'

type Props = { userId: string }

export function SettingsPushNotifications({ userId: _userId }: Props) {
  const { t } = useTranslation()
  const [permission, setPermission] =
    useState<NotificationPermission>('default')
  const [hasBrowserSubscription, setHasBrowserSubscription] = useState(false)
  const [hasNativeSubscription, setHasNativeSubscription] = useState(false)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [mode, setMode] = useState<'fcm' | 'direct' | null>(null)

  const vapidOk = !!getVapidPublicKey()
  const pushSupported = supportsWebPush() || supportsNativePush()

  const refresh = useCallback(async () => {
    const p = await getNotificationPermission()
    setPermission(p)
    if (!supportsWebPush()) {
      const nativeToken =
        typeof window !== 'undefined' ? window.localStorage.getItem('p13:native_push_token') : null
      setHasNativeSubscription(!!nativeToken)
      const storedMode = getStoredNotificationMode()
      setMode(storedMode)
      if (storedMode === 'direct') {
        const running = await getDirectForegroundModeState().catch(() => false)
        setHasNativeSubscription(running)
      }
    }
    if (!pushSupported) {
      setHasBrowserSubscription(false)
      return
    }
    try {
      const sub = await getExistingPushSubscription()
      setHasBrowserSubscription(!!sub && p === 'granted')
    } catch (e) {
      console.error('[push] Settings: could not read subscription state', e)
      setHasBrowserSubscription(false)
    }
  }, [pushSupported])

  useEffect(() => {
    warnIfVapidPublicKeyMissing()
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onToggleEnable() {
    setLocalError(null)
    setBusy(true)
    try {
      if (hasBrowserSubscription || hasNativeSubscription) {
        await unsubscribeUserPush()
      } else {
        if (!nativeSupported && !vapidOk) {
          setLocalError(t('settings.pushVapidMissing'))
          return
        }
        await subscribeUserPush()
      }
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[push] Settings toggle failed', e)
      if (msg === 'NOTIFICATION_DENIED') {
        setLocalError(t('settings.pushBlocked'))
      } else if (msg === 'SERVICE_WORKER_REGISTER_FAILED') {
        setLocalError(t('settings.pushNoSw'))
      } else if (msg === 'WEB_PUSH_UNSUPPORTED') {
        setLocalError(t('settings.pushUnsupported'))
      } else {
        setLocalError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  async function onModeSelect(nextMode: 'fcm' | 'direct') {
    setBusy(true)
    setLocalError(null)
    try {
      await setNotificationMode(nextMode)
      setMode(nextMode)
      await refresh()
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const nativeSupported = supportsNativePush()
  const showEnableButton =
    permission !== 'denied' &&
    pushSupported &&
    !(hasBrowserSubscription || hasNativeSubscription) &&
    (nativeSupported || vapidOk)

  const pushActive = hasNativeSubscription || (hasBrowserSubscription && permission === 'granted')

  return (
    <div className="border-t border-neon-cyan/30 pt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-widest text-neon-cyan">
          {t('settings.notificationsTitle')}
        </p>
        {pushActive ? (
          <Bell className="h-4 w-4 shrink-0 text-neon-cyan" aria-hidden />
        ) : (
          <BellOff className="h-4 w-4 shrink-0 text-danger" aria-hidden />
        )}
      </div>
      <p className="mb-2 text-[9px] text-danger">{t('settings.notificationsHint')}</p>

      {!pushSupported ? (
        <p className="font-mono text-[10px] uppercase tracking-wider text-danger">
          :: {t('settings.pushUnsupported')}
        </p>
      ) : null}

      {permission === 'denied' ? (
        <p className="border border-neon-red/50 bg-void px-2 py-2 font-mono text-[10px] uppercase tracking-wide text-neon-red">
          :: {t('settings.pushBlocked')}
        </p>
      ) : null}

      {!vapidOk ? (
        <p className="text-[9px] text-danger">{t('settings.pushVapidMissing')}</p>
      ) : null}

      {supportsNativePush() && supportsDirectForegroundMode() ? (
        <div className="mt-3 space-y-2 border border-border-strong px-2 py-2">
          <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
            {t('settings.notificationModeTitle')}
          </p>
          <p className="text-[9px] text-text-muted">{t('settings.notificationModeSettingsHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onModeSelect('direct')}
              className={`border px-2 py-2 text-left text-[10px] uppercase tracking-wide ${
                mode === 'direct'
                  ? 'border-neon-cyan text-neon-cyan'
                  : 'border-border-strong text-text-muted'
              }`}
            >
              <span className="block">{t('settings.notificationModeDirect')}</span>
              <span className="mt-1 block text-[9px] normal-case tracking-normal">
                {t('settings.notificationModeDirectHint')}
              </span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onModeSelect('fcm')}
              className={`border px-2 py-2 text-left text-[10px] uppercase tracking-wide ${
                mode === 'fcm'
                  ? 'border-neon-red text-neon-red'
                  : 'border-border-strong text-text-muted'
              }`}
            >
              <span className="block">{t('settings.notificationModeFcm')}</span>
              <span className="mt-1 block text-[9px] normal-case tracking-normal">
                {t('settings.notificationModeFcmHint')}
              </span>
            </button>
          </div>
        </div>
      ) : null}

      {permission === 'granted' && hasBrowserSubscription ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-neon-cyan">
            :: {t('settings.pushEnabled')}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onToggleEnable()}
            className="shrink-0 border border-neon-red/70 bg-void px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red transition-colors hover:bg-neon-red/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '[ … ]' : t('settings.pushDisable')}
          </button>
        </div>
      ) : null}

      {showEnableButton ? (
        <button
          type="button"
          disabled={busy || (!nativeSupported && !vapidOk)}
          onClick={() => void onToggleEnable()}
          className="w-full border border-neon-cyan/70 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '[ … ]' : t('settings.pushEnable')}
        </button>
      ) : null}

      {permission === 'granted' && !hasBrowserSubscription && vapidOk && pushSupported ? (
        <p className="mt-1 text-[9px] text-text-muted">
          {t('settings.pushGrantNoSubHint')}
        </p>
      ) : null}

      {localError ? (
        <p className="mt-2 font-mono text-[10px] text-neon-red">[!] {localError}</p>
      ) : null}
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  fetchDevices,
  revokeDevice,
  type DeviceRow,
} from '@/lib/api/devices'
import { useAuth } from '@/components/auth/auth-provider'
import { SettingsLinkDeviceModal } from '@/components/settings-link-device-modal'
import { useTranslation } from '@/hooks/use-translation'

type Props = { userId: string; active: boolean }

export function SettingsDevicesPanel({ userId, active }: Props) {
  const { t } = useTranslation()
  const { user, refresh, logout } = useAuth()
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [linkQrOpen, setLinkQrOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchDevices()
      setDevices(d.devices)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (active) void load()
  }, [active, userId, load])

  async function onRevoke(d: DeviceRow) {
    if (d.revoked) return
    if (!window.confirm(`${t('settings.devicesRevokeConfirm')} (${d.device_name})`)) {
      return
    }
    setBusyId(d.id)
    setError(null)
    try {
      await revokeDevice(d.id)
      await load()
      await refresh()
      if (d.is_current) {
        await logout()
        window.location.href = '/login'
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4 border-t border-neon-cyan/30 pt-3">
      {linkQrOpen ? (
        <SettingsLinkDeviceModal onClose={() => setLinkQrOpen(false)} />
      ) : null}
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-neon-cyan">
          {t('settings.devicesSectionTitle')}
        </p>
        <p className="mt-1 break-words text-[9px] text-red-800">
          {t('settings.devicesHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <button
          type="button"
          onClick={() => setLinkQrOpen(true)}
          className="w-full border border-neon-cyan/70 bg-black px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-cyan/10 active:scale-95 sm:w-auto"
        >
          [ {t('settings.linkDeviceCta')} ]
        </button>
      </div>

      {error ? (
        <p className="border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red">
          [!] {error}
        </p>
      ) : null}

      <div className="relative min-h-[10rem]">
        {loading ? (
          <div
            className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-black/55 backdrop-blur-[1px]"
            aria-hidden
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-neon-cyan/90">
              [ LOADING... ]
            </span>
          </div>
        ) : null}
        <ul
          className={`max-h-64 space-y-2 overflow-y-auto border border-neon-cyan/20 p-2 ${
            loading ? 'opacity-40' : ''
          }`}
        >
        {devices.map((d) => (
          <li
            key={d.id}
            className="border border-zinc-800 bg-black/80 px-2 py-2 font-mono text-[10px] text-zinc-300"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-neon-cyan">
                  {d.device_name}
                  {d.is_current ? (
                    <span className="ml-2 border border-neon-cyan px-1 text-[9px] uppercase text-neon-cyan">
                      {t('settings.devicesCurrent')}
                    </span>
                  ) : null}
                  {d.is_master ? (
                    <span className="ml-2 border border-yellow-500 px-1 text-[9px] uppercase text-yellow-500">
                      {t('settings.devicesMaster')}
                    </span>
                  ) : null}
                  {d.revoked ? (
                    <span className="ml-2 text-red-700">
                      {t('settings.devicesRevoked')}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-[9px] text-zinc-600">
                  {d.last_active} · {d.ip_address ?? '—'}
                </p>
              </div>
              {!d.revoked && !d.is_master ? (
                <button
                  type="button"
                  disabled={busyId === d.id}
                  onClick={() => void onRevoke(d)}
                  className="shrink-0 border border-neon-red/70 px-2 py-1 text-[9px] uppercase text-neon-red transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-red/10 active:scale-95 disabled:opacity-40"
                >
                  {busyId === d.id ? '…' : t('settings.devicesRevoke')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {!loading && devices.length === 0 ? (
          <li className="text-[10px] text-zinc-600">:: NO_ROWS</li>
        ) : null}
        </ul>
      </div>
      <p className="text-[9px] text-zinc-600">
        device_id:{' '}
        <span className="text-neon-cyan/80">{user?.device_id ?? '—'}</span>
      </p>
    </div>
  )
}

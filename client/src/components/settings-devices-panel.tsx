'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  fetchDevices,
  revokeDevice,
  setMasterDevice,
  revokeAllOtherSessions,
  clearRevokedDevices,
  reauthorizeDevice,
  type DeviceRow,
} from '@/lib/api/devices'
import { useAuth } from '@/components/auth/auth-provider'
import { SettingsLinkDeviceModal } from '@/components/settings-link-device-modal'
import { useTranslation } from '@/hooks/use-translation'
import { readVaultBlob, unwrapPrivateJwkWithPin } from '@/lib/vault'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = { userId: string; active: boolean }

export function SettingsDevicesPanel({ userId, active }: Props) {
  const { t } = useTranslation()
  const { user, refresh, logout } = useAuth()
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [linkQrOpen, setLinkQrOpen] = useState(false)
  const [showVaultExportPrompt, setShowVaultExportPrompt] = useState(false)
  const [reauthDevice, setReauthDevice] = useState<DeviceRow | null>(null)
  const [reauthPin, setReauthPin] = useState('')
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [reauthBusy, setReauthBusy] = useState(false)

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

  async function onSetMaster(d: DeviceRow) {
    if (d.is_master || d.revoked) return
    setBusyId(d.id)
    setBusyAction('master')
    setError(null)
    try {
      await setMasterDevice(d.id)
      await load()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusyId(null)
      setBusyAction(null)
    }
  }

  async function onRevokeAllOthers() {
    if (!window.confirm(t('settings.devicesRevokeConfirm'))) {
      return
    }
    setBusyAction('terminate-all')
    setError(null)
    try {
      await revokeAllOtherSessions()
      await load()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusyAction(null)
    }
  }

  async function onClearRevoked() {
    setBusyAction('clear-revoked')
    setError(null)
    try {
      await clearRevokedDevices()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusyAction(null)
    }
  }

  async function onReauthorize() {
    if (!reauthDevice || !reauthPin.trim()) return
    setReauthBusy(true)
    setReauthError(null)
    try {
      const blob = readVaultBlob(userId)
      if (!blob) {
        setReauthError(t('settings.noLocalVault'))
        setReauthBusy(false)
        return
      }
      await unwrapPrivateJwkWithPin(blob, reauthPin)
      await reauthorizeDevice(reauthDevice.id)
      setReauthDevice(null)
      setReauthPin('')
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('settings.unknown')
      if (msg.includes('decrypt') || msg.includes('unwrap') || msg.includes('OperationError')) {
        setReauthError(t('settings.killPinBad'))
      } else {
        setReauthError(msg)
      }
    } finally {
      setReauthBusy(false)
    }
  }

  function exportVault() {
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError(t('settings.noLocalVault'))
      return
    }
    const payload = JSON.stringify(
      { userId, vault: blob, exported_at: new Date().toISOString() },
      null,
      2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `13vault.key`
    a.click()
    URL.revokeObjectURL(url)
    setShowVaultExportPrompt(false)
  }

  function handleLinkDeviceClick() {
    const blob = readVaultBlob(userId)
    if (!blob) {
      window.alert(t('settings.noLocalVault'))
      setShowVaultExportPrompt(true)
      return
    }
    setLinkQrOpen(true)
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

      {/* Объяснение QR-входа */}
      <div className="border border-neon-cyan/10 bg-zinc-950/60 p-3 space-y-1">
        <p className="text-[9px] uppercase tracking-widest text-neon-cyan/70">[ ДОБАВИТЬ УСТРОЙСТВО :: QR ]</p>
        <p className="text-[9px] text-zinc-500 leading-relaxed">
          Нажми «Добавить устройство» — появится QR-код. Открой на новом устройстве браузер и отсканируй его камерой или через приложение. Новое устройство автоматически получит сессию без ввода пароля. QR действителен <span className="text-zinc-300">5 минут</span> и одноразовый.
        </p>
      </div>

      {/* Объяснение резервного ключа */}
      <div className="border border-neon-red/20 bg-zinc-950/60 p-3 space-y-1">
        <p className="text-[9px] uppercase tracking-widest text-neon-red/80">[ РЕЗЕРВНАЯ КОПИЯ КЛЮЧА ]</p>
        <p className="text-[9px] text-zinc-500 leading-relaxed">
          Твой приватный ключ хранится <span className="text-zinc-300">только локально</span> в этом браузере. Сервер его не знает и восстановить не может. Скачай резервную копию и храни в безопасном месте — без неё при потере браузера аккаунт будет недоступен навсегда.
        </p>
        <p className="text-[9px] text-zinc-600">
          Файл зашифрован твоим vault-паролем — без него он бесполезен.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <button
          type="button"
          onClick={handleLinkDeviceClick}
          className="w-full border border-neon-cyan/70 bg-black px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-cyan/10 active:scale-95 sm:w-auto"
        >
          {t('settings.linkDeviceCta')}
        </button>
        <TerminalGlitchButton
          type="button"
          onClick={exportVault}
          className="w-full min-w-0 !px-2 !py-1.5 !text-[9px] whitespace-nowrap sm:flex-1"
        >
          {t('settings.vaultBackup')}
        </TerminalGlitchButton>
        {devices.some(d => !d.revoked && d.id !== user?.device_id) && (
          <TerminalGlitchButton
            type="button"
            onClick={() => void onRevokeAllOthers()}
            disabled={busyAction === 'terminate-all'}
            className="w-full min-w-0 !px-2 !py-1.5 !text-[9px] whitespace-nowrap !border-neon-red !text-neon-red hover:!bg-neon-red/10 sm:flex-1"
          >
            {busyAction === 'terminate-all' ? '…' : t('settings.devicesRevoke')}
          </TerminalGlitchButton>
        )}
        {devices.some(d => d.revoked) && (
          <TerminalGlitchButton
            type="button"
            onClick={() => void onClearRevoked()}
            disabled={busyAction === 'clear-revoked'}
            className="w-full min-w-0 !px-2 !py-1.5 !text-[9px] whitespace-nowrap !border-zinc-600 !text-zinc-400 hover:!bg-zinc-800/30 sm:flex-1"
          >
            {busyAction === 'clear-revoked' ? '…' : t('settings.digitalDenClear')}
          </TerminalGlitchButton>
        )}
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
              {t('common.loading')}
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
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={busyId === d.id}
                    onClick={() => void onSetMaster(d)}
                    className="shrink-0 border border-yellow-500/70 px-2 py-1 text-[9px] uppercase text-yellow-500 transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-yellow-500/10 active:scale-95 disabled:opacity-40"
                  >
                    {busyId === d.id && busyAction === 'master' ? '…' : t('settings.devicesMaster')}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === d.id}
                    onClick={() => void onRevoke(d)}
                    className="shrink-0 border border-neon-red/70 px-2 py-1 text-[9px] uppercase text-neon-red transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-red/10 active:scale-95 disabled:opacity-40"
                  >
                    {busyId === d.id ? '…' : t('settings.devicesRevoke')}
                  </button>
                </div>
              ) : !d.revoked && d.is_master ? (
                <span className="text-[9px] text-yellow-500">{t('settings.devicesMaster')}</span>
              ) : !d.revoked ? (
                <button
                  type="button"
                  disabled={busyId === d.id}
                  onClick={() => void onRevoke(d)}
                  className="shrink-0 border border-neon-red/70 px-2 py-1 text-[9px] uppercase text-neon-red transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-red/10 active:scale-95 disabled:opacity-40"
                >
                  {busyId === d.id ? '…' : t('settings.devicesRevoke')}
                </button>
              ) : d.revoked ? (
                <button
                  type="button"
                  onClick={() => {
                    setReauthDevice(d)
                    setReauthPin('')
                    setReauthError(null)
                  }}
                  className="shrink-0 border border-neon-cyan/50 px-2 py-1 text-[9px] uppercase text-neon-cyan transition-all duration-200 ease-in-out hover:scale-[1.02] hover:bg-neon-cyan/10 active:scale-95"
                >
                  {t('settings.devicesReauthorize')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {!loading && devices.length === 0 ? (
          <li className="text-[10px] text-zinc-600">{t('sidebar.noActiveRoutes')}</li>
        ) : null}
        </ul>
      </div>
      <p className="text-[9px] text-zinc-600">
        device_id:{' '}
        <span className="text-neon-cyan/80">{user?.device_id ?? '—'}</span>
      </p>

      {reauthDevice ? (
        <div className="border border-neon-cyan/50 bg-black/80 p-3 space-y-2">
          <p className="text-[10px] text-neon-cyan uppercase tracking-widest">
            {t('settings.devicesReauthorize')}: {reauthDevice.device_name}
          </p>
          <p className="text-[9px] text-zinc-400">
            {t('settings.devicesReauthorizeHint')}
          </p>
          <input
            type="password"
            value={reauthPin}
            onChange={(e) => setReauthPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onReauthorize()
            }}
            placeholder={t('settings.killPinLabel')}
            className="w-full border border-neon-cyan/30 bg-black px-2 py-1.5 font-mono text-[10px] text-neon-cyan placeholder-zinc-600 focus:border-neon-cyan focus:outline-none"
            autoFocus
          />
          {reauthError ? (
            <p className="text-[9px] text-neon-red">[!] {reauthError}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onReauthorize()}
              disabled={reauthBusy || !reauthPin.trim()}
              className="flex-1 border border-neon-cyan px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
            >
              {reauthBusy ? '...' : t('common.confirm')}
            </button>
            <button
              type="button"
              onClick={() => {
                setReauthDevice(null)
                setReauthPin('')
                setReauthError(null)
              }}
              className="flex-1 border border-zinc-600 px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-zinc-400 hover:bg-zinc-800/30"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {showVaultExportPrompt && (
        <div className="border border-neon-red/50 bg-black/80 p-3">
          <p className="mb-2 text-[9px] text-neon-red">
            {t('settings.vaultBackupHint')}
          </p>
          <button
            type="button"
            onClick={exportVault}
            className="w-full border border-neon-cyan px-2 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
          >
            {t('settings.vaultBackup')}
          </button>
        </div>
      )}
    </div>
  )
}

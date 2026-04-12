'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { API_URL, fetchMe } from '@/lib/api/auth'
import { useAuth } from '@/components/auth/auth-provider'
import { nuclearWipeClient } from '@/lib/client-wipe'
import {
  readVaultBlob,
  unwrapPrivateJwkWithPin,
} from '@/lib/vault'
import { purgeLocalMessageCache } from '@/lib/message-cache'
import { clearAllMediaCache } from '@/lib/media-cache'
import { SettingsDevicesPanel } from '@/components/settings-devices-panel'
import { SettingsMediaPanel } from '@/components/settings-media-panel'
import { SettingsPushNotifications } from '@/components/settings-push-notifications'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { SettingsAvatarSection } from '@/components/settings-avatar-section'
import { LogoutButton } from '@/components/logout-button'
import { useTranslation } from '@/hooks/use-translation'

type Props = { userId: string; username: string; onClose: () => void }

/** Server JSON must be boolean — no client-side default to visible. */
function readDiscoverableFromPayload(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return false
}

export function SettingsModal({ userId, username, onClose }: Props) {
  const { locale, setLocale, t } = useTranslation()
  const { user, updateUser, refresh } = useAuth()
  /** `null` until GET /users/me/settings succeeds — never assume true (shadow default). */
  const [discoverable, setDiscoverable] = useState<boolean | null>(null)
  const [hidePresence, setHidePresence] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [totpSetup, setTotpSetup] = useState<{
    qr_data_url: string
    secret: string
  } | null>(null)
  const [totpEnableCode, setTotpEnableCode] = useState('')
  const [totpDisableCode, setTotpDisableCode] = useState('')
  const [totpBusy, setTotpBusy] = useState(false)
  const [totpDisableOpen, setTotpDisableOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'main' | 'media' | 'devices'>(
    'main'
  )
  const [killOpen, setKillOpen] = useState(false)
  const [killPhrase, setKillPhrase] = useState('')
  const [killPin, setKillPin] = useState('')
  const [allowNewDeviceLinking, setAllowNewDeviceLinking] = useState(false)

  const loadSettingsFromApi = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch(`${API_URL}/users/me/settings`, {
        credentials: 'include',
      })
      const d = (await r.json().catch(() => ({}))) as {
        is_discoverable?: unknown
        hide_presence?: unknown
        error?: string
      }
      if (!r.ok) {
        setError(d.error ?? t('settings.loadFailed'))
        return
      }
      const value = readDiscoverableFromPayload(d.is_discoverable)
      setDiscoverable(value)
      updateUser({ is_discoverable: value })
      setHidePresence(typeof d.hide_presence === 'boolean' ? d.hide_presence : false)
    } catch {
      setError(t('settings.loadFailed'))
    }
  }, [t, updateUser])

  useEffect(() => {
    void loadSettingsFromApi()
  }, [userId, loadSettingsFromApi])

  useEffect(() => {
    const stored = localStorage.getItem('p13:allow_new_device_linking')
    setAllowNewDeviceLinking(stored === 'true')
  }, [userId])

  useEffect(() => {
    void (async () => {
      try {
        const { user: u } = await fetchMe()
        updateUser({ totp_enabled: u.totp_enabled })
      } catch {
        /* ignore */
      }
    })()
  }, [userId, updateUser])

  async function startTotpSetup() {
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/setup`, {
        method: 'POST',
        credentials: 'include',
      })
      const d = (await r.json().catch(() => ({}))) as {
        qr_data_url?: string
        secret?: string
        error?: string
      }
      if (!r.ok) {
        throw new Error(d.error ?? 'SETUP_FAILED')
      }
      if (!d.qr_data_url || !d.secret) {
        throw new Error('INVALID_SETUP_RESPONSE')
      }
      setTotpSetup({ qr_data_url: d.qr_data_url, secret: d.secret })
      setTotpEnableCode('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setTotpBusy(false)
    }
  }

  async function confirmTotpSetup() {
    const digits = totpEnableCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length !== 6) {
      setError(t('login.totpSixDigits'))
      return
    }
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/verify-setup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        totp_enabled?: boolean
        error?: string
      }
      if (!r.ok) {
        throw new Error(d.error ?? 'VERIFY_SETUP_FAILED')
      }
      setTotpSetup(null)
      setTotpEnableCode('')
      updateUser({ totp_enabled: true })
      await refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setTotpBusy(false)
    }
  }

  async function disableTotp() {
    const digits = totpDisableCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length !== 6) {
      setError(t('login.totpSixDigits'))
      return
    }
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/disable`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits }),
      })
      const d = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        throw new Error(d.error ?? 'DISABLE_FAILED')
      }
      setTotpDisableOpen(false)
      setTotpDisableCode('')
      updateUser({ totp_enabled: false })
      await refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setTotpBusy(false)
    }
  }

  async function toggleHidePresence() {
    if (hidePresence === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const nextRequest = !hidePresence
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide_presence: nextRequest }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        hide_presence?: unknown
        error?: string
      }
      if (!r.ok) {
        throw new Error(d.error ?? t('settings.toggleFailed'))
      }
      if (typeof d.hide_presence !== 'boolean') {
        throw new Error(t('settings.toggleFailed'))
      }
      setHidePresence(d.hide_presence)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusy(false)
    }
  }

  async function toggleDiscoverable() {
    if (discoverable === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const nextRequest = !discoverable
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_discoverable: nextRequest }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        is_discoverable?: unknown
        error?: string
      }
      if (!r.ok) {
        throw new Error(d.error ?? t('settings.toggleFailed'))
      }
      if (typeof d.is_discoverable !== 'boolean') {
        throw new Error(t('settings.toggleFailed'))
      }
      setDiscoverable(d.is_discoverable)
      updateUser({ is_discoverable: d.is_discoverable })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusy(false)
    }
  }

  async function purgeLocalCache() {
    try {
      await clearAllMediaCache()
    } catch {
      /* ignore */
    }
    try {
      await purgeLocalMessageCache()
    } catch {
      /* ignore */
    }
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      /* ignore */
    }
    window.location.reload()
  }

  async function runGlobalKillSwitch() {
    setError(null)
    const expected = '!!_GLOBAL_KILL_SWITCH_!!'
    if (killPhrase !== expected) {
      setError(t('settings.killPhraseMismatch'))
      return
    }
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError(t('settings.noLocalVault'))
      return
    }
    try {
      await unwrapPrivateJwkWithPin(blob, killPin)
    } catch {
      setError(t('settings.killPinBad'))
      return
    }
    setBusy(true)
    void nuclearWipeClient({ revokeServerSessions: true })
  }

  function exportVault() {
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError(t('settings.noLocalVault'))
      return
    }
    const payload = JSON.stringify(
      { userId, username, vault: blob, exported_at: new Date().toISOString() },
      null,
      2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `forest_vault_key.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const settingsReady = discoverable !== null && hidePresence !== null
  const discoverableOn = discoverable === true
  const ghostOn = hidePresence === true

  const settingsBtn =
    'border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto overflow-x-hidden bg-black/90 px-3 py-6 sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('common.settings')}
    >
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={`terminal-panel flex max-h-[min(92dvh,92vh)] w-full min-w-0 flex-col overflow-hidden ${settingsTab === 'media' || settingsTab === 'devices' ? 'max-w-2xl' : totpSetup ? 'max-w-lg' : 'max-w-md'}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-2 border-b border-neon-red/40 pb-3">
          <p className="min-w-0 break-words text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ SETTINGS ] :: {username}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 font-mono text-xs text-neon-red transition-all duration-200 ease-in-out hover:text-neon-cyan active:scale-95"
          >
            [X]
          </button>
        </header>

        <div className="flex shrink-0 flex-col gap-2 border-b border-neon-cyan/20 py-2 sm:flex-row sm:flex-wrap sm:overflow-x-auto">
          <button
            type="button"
            onClick={() => setSettingsTab('main')}
            className={`${settingsBtn} hover:scale-[1.02] active:scale-95 ${
              settingsTab === 'main'
                ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                : 'border-zinc-700 bg-black text-zinc-500 hover:border-neon-cyan/50'
            }`}
          >
            [ {t('settings.tabGeneral')} ]
          </button>
          <button
            type="button"
            onClick={() => setSettingsTab('media')}
            className={`${settingsBtn} hover:scale-[1.02] active:scale-95 ${
              settingsTab === 'media'
                ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                : 'border-zinc-700 bg-black text-zinc-500 hover:border-neon-cyan/50'
            }`}
          >
            [ {t('settings.tabMedia')} ]
          </button>
          <button
            type="button"
            onClick={() => setSettingsTab('devices')}
            className={`${settingsBtn} hover:scale-[1.02] active:scale-95 ${
              settingsTab === 'devices'
                ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                : 'border-zinc-700 bg-black text-zinc-500 hover:border-neon-cyan/50'
            }`}
          >
            [ {t('settings.tabDevices')} ]
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-2 py-4">

        {settingsTab === 'media' ? <SettingsMediaPanel active /> : null}
        {settingsTab === 'devices' ? (
          <SettingsDevicesPanel userId={userId} active />
        ) : null}

        <div
          className={`space-y-3 ${settingsTab !== 'main' ? 'hidden' : ''}`}
        >
          <SettingsAvatarSection userId={userId} username={username} />
          <SettingsPushNotifications userId={userId} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('settings.discoverable')}
              </p>
              <p className="break-words text-[9px] text-red-800">
                {t('settings.discoverableHint')}
              </p>
              <p
                className={`mt-1 font-mono text-[9px] uppercase tracking-wider ${
                  !settingsReady
                    ? 'text-zinc-600'
                    : discoverableOn
                      ? 'text-neon-cyan'
                      : 'text-zinc-500'
                }`}
              >
                {!settingsReady
                  ? ':: …'
                  : discoverableOn
                    ? t('settings.discoverableBadgeOn')
                    : t('settings.discoverableBadgeOff')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={discoverableOn}
              title={
                !settingsReady
                  ? '…'
                  : discoverableOn
                    ? t('settings.discoverableTooltipOn')
                    : t('settings.discoverableTooltipOff')
              }
              disabled={busy || !settingsReady}
              onClick={() => void toggleDiscoverable()}
              className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                !settingsReady
                  ? 'border-zinc-700 bg-zinc-950 text-zinc-600'
                  : discoverableOn
                    ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                    : 'border-zinc-600 bg-zinc-950 text-zinc-400'
              } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}
            >
              {busy ? '[ … ]' : !settingsReady ? '[ -- ]' : discoverableOn ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('settings.ghostPresence')}
              </p>
              <p className="break-words text-[9px] text-red-800">
                {t('settings.ghostPresenceHint')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ghostOn}
              title={t('settings.ghostPresence')}
              disabled={busy || !settingsReady}
              onClick={() => void toggleHidePresence()}
              className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                !settingsReady
                  ? 'border-zinc-700 bg-zinc-950 text-zinc-600'
                  : ghostOn
                    ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                    : 'border-zinc-600 bg-zinc-950 text-zinc-400'
              } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}
            >
              {busy ? '[ … ]' : !settingsReady ? '[ -- ]' : ghostOn ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>

          <div className="border-t border-neon-cyan/30 pt-3">
            <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">
              {t('settings.totpSection')}
            </p>
            <p className="mb-3 text-[9px] text-red-800">{t('settings.totpHint')}</p>
            {user?.totp_enabled === true ? (
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-neon-cyan">
                  :: {t('settings.totpActive')}
                </p>
                {!totpDisableOpen ? (
                  <button
                    type="button"
                    disabled={totpBusy}
                    onClick={() => {
                      setTotpDisableOpen(true)
                      setTotpDisableCode('')
                      setError(null)
                    }}
                    className="w-full border border-neon-red/70 bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                  >
                    [ {t('settings.totpDisable')} ]
                  </button>
                ) : (
                  <div className="space-y-2 border border-neon-red/40 p-2">
                    <p className="text-[9px] text-red-800">
                      {t('settings.totpDisableWarn')}
                    </p>
                    <label className="terminal-label" htmlFor="totp-disable-code">
                      {t('settings.totpDisableCode')}
                    </label>
                    <input
                      id="totp-disable-code"
                      className="terminal-input"
                      inputMode="numeric"
                      maxLength={6}
                      value={totpDisableCode}
                      onChange={(e) =>
                        setTotpDisableCode(
                          e.target.value.replace(/\D/g, '').slice(0, 6)
                        )
                      }
                      placeholder="000000"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={totpBusy}
                        onClick={() => void disableTotp()}
                        className="flex-1 border border-neon-red bg-black py-1 font-mono text-[10px] uppercase text-neon-red hover:bg-neon-red/10 disabled:opacity-40"
                      >
                        [ CONFIRM ]
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTotpDisableOpen(false)
                          setTotpDisableCode('')
                        }}
                        className="flex-1 border border-neon-cyan/40 py-1 font-mono text-[10px] text-neon-cyan"
                      >
                        [ CANCEL ]
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-red-800">
                  :: {t('settings.totpInactive')}
                </p>
                {!totpSetup ? (
                  <button
                    type="button"
                    disabled={totpBusy}
                    onClick={() => void startTotpSetup()}
                    className="w-full border border-neon-cyan bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
                  >
                    [ {t('settings.totpSetup')} ]
                  </button>
                ) : (
                  <div className="space-y-3 border border-neon-cyan/30 p-3">
                    <p className="text-[9px] text-neon-cyan/90">
                      {t('settings.totpScanQr')}
                    </p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={totpSetup.qr_data_url}
                      alt=""
                      className="mx-auto border border-neon-cyan/40 bg-white p-1"
                      width={192}
                      height={192}
                    />
                    <p className="text-[9px] text-red-800">
                      {t('settings.totpSecretManual')}
                    </p>
                    <p className="break-all font-mono text-[9px] text-neon-cyan/80 overflow-x-hidden">
                      {totpSetup.secret}
                    </p>
                    <label className="terminal-label" htmlFor="totp-enable-code">
                      {t('settings.totpEnableCode')}
                    </label>
                    <input
                      id="totp-enable-code"
                      className="terminal-input"
                      inputMode="numeric"
                      maxLength={6}
                      value={totpEnableCode}
                      onChange={(e) =>
                        setTotpEnableCode(
                          e.target.value.replace(/\D/g, '').slice(0, 6)
                        )
                      }
                      placeholder="000000"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={totpBusy}
                        onClick={() => void confirmTotpSetup()}
                        className="border border-neon-cyan px-3 py-1 font-mono text-[10px] uppercase text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
                      >
                        [ {t('settings.totpConfirm')} ]
                      </button>
                      <button
                        type="button"
                        disabled={totpBusy}
                        onClick={() => {
                          setTotpSetup(null)
                          setTotpEnableCode('')
                        }}
                        className="border border-red-900 px-3 py-1 font-mono text-[10px] uppercase text-red-800 hover:text-neon-red"
                      >
                        [ {t('settings.totpCancelSetup')} ]
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-neon-cyan/30 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('common.deviceLinking')} · NEW_DEVICE_GATE
              </p>
              <p className="break-words text-[9px] text-red-800">
                {allowNewDeviceLinking
                  ? 'ON: New devices can link via QR'
                  : 'OFF: New device linking blocked (default)'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const newVal = !allowNewDeviceLinking
                setAllowNewDeviceLinking(newVal)
                localStorage.setItem('p13:allow_new_device_linking', String(newVal))
              }}
              className={`shrink-0 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest ${
                allowNewDeviceLinking
                  ? 'border-neon-cyan bg-neon-cyan/20 text-neon-cyan'
                  : 'border-neon-red bg-neon-red/10 text-neon-red'
              }`}
            >
              [{allowNewDeviceLinking ? 'ON' : 'OFF'}]
            </button>
          </div>

          <div className="flex flex-col gap-2 border-t border-neon-cyan/30 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('common.language')} / Язык
              </p>
              <p className="break-words text-[9px] text-red-800">
                {t('settings.languageHint')}
              </p>
            </div>
            <select
              className="terminal-input h-8 w-full max-w-[10rem] shrink-0 py-1 text-xs uppercase"
              value={locale}
              onChange={(e) => setLocale(e.target.value === 'ru' ? 'ru' : 'en')}
              aria-label={`${t('common.language')} / Язык`}
            >
              <option value="en">EN</option>
              <option value="ru">RU</option>
            </select>
          </div>

          <div className="border-t border-neon-cyan/30 pt-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-neon-cyan">
              {t('settings.vaultBackup')}
            </p>
            <p className="mb-2 break-words text-[9px] text-zinc-500">
              {t('settings.vaultBackupHint')}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
              <TerminalGlitchButton
                type="button"
                onClick={exportVault}
                className="w-full min-w-0 !px-2 !py-1.5 !text-[9px] whitespace-nowrap sm:flex-1"
              >
                [ ↓ EXPORT VAULT KEY ]
              </TerminalGlitchButton>
            </div>
          </div>

          <div className="border-t border-neon-red/40 pt-3">
            <p className="mb-1 text-xs uppercase tracking-widest text-neon-red">
              {t('settings.dangerZone')}
            </p>
            <p className="mb-2 break-words text-[9px] text-zinc-500">
              {t('settings.purgeHint')}
            </p>
            <TerminalGlitchButton
              type="button"
              onClick={() => void purgeLocalCache()}
              className="w-full !border-neon-red !px-2 !py-2 !text-[10px] !text-neon-red hover:!bg-neon-red/10"
            >
              [ {t('settings.purgeLocalCache')} ]
            </TerminalGlitchButton>
          </div>

          <div className="border-t border-red-600/50 pt-3">
            <button
              type="button"
              onClick={() => setKillOpen((v) => !v)}
              className="glitch-text mb-2 w-full border border-red-600 bg-black py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-red-500 hover:bg-red-950/40"
            >
              [ !!_GLOBAL_KILL_SWITCH_!! ]
            </button>
            <AnimatePresence initial={false}>
              {killOpen ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <p className="mb-2 break-words text-[9px] text-red-800">
                    {t('settings.killSwitchHint')}
                  </p>
                  <label className="terminal-label" htmlFor="kill-phrase">
                    {t('settings.killPhraseLabel')}
                  </label>
                  <input
                    id="kill-phrase"
                    className="terminal-input mb-2 text-[10px]"
                    value={killPhrase}
                    onChange={(e) => setKillPhrase(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <label className="terminal-label" htmlFor="kill-pin">
                    {t('settings.killPinLabel')}
                  </label>
                  <input
                    id="kill-pin"
                    type="password"
                    className="terminal-input mb-2 text-[10px]"
                    value={killPin}
                    onChange={(e) => setKillPin(e.target.value)}
                    autoComplete="off"
                  />
                  <TerminalGlitchButton
                    type="button"
                    disabled={busy}
                    onClick={() => void runGlobalKillSwitch()}
                    className="w-full !border-red-600 !py-2 !text-[10px] !text-red-500 hover:!bg-red-950/50"
                  >
                    [ {t('settings.killExecute')} ]
                  </TerminalGlitchButton>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        {error ? (
          <p className="shrink-0 border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red break-words overflow-x-hidden">
            [!] {error}
          </p>
        ) : null}
        {saved ? (
          <p className="shrink-0 text-[10px] text-neon-cyan">:: {t('common.saved')}</p>
        ) : null}
        <div className="mt-2 shrink-0 border-t border-red-900/50 px-0.5 pt-3">
          <LogoutButton variant="critical" />
        </div>
        </div>

      </motion.div>
    </div>
  )
}

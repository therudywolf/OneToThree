'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { API_URL, fetchMe } from '@/lib/api/auth'
import { useAuth } from '@/components/auth/auth-provider'
import { nuclearWipeClient } from '@/lib/client-wipe'
import {
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  wrapPrivateJwkWithPin,
  persistVaultBlob,
  persistVaultBlobByLoginUsername,
} from '@/lib/vault'
import { changeVaultPinOnServer } from '@/lib/api/vault'
import {
  AUTO_LOCK_OPTIONS,
  loadAutoLockTimeout,
  saveAutoLockTimeout,
  type AutoLockTimeout,
} from '@/hooks/use-auto-lock'
import { purgeLocalMessageCache } from '@/lib/message-cache'
import { clearAllMediaCache } from '@/lib/media-cache'
import { SettingsDevicesPanel } from '@/components/settings-devices-panel'
import { SettingsMediaPanel } from '@/components/settings-media-panel'
import { SettingsPushNotifications } from '@/components/settings-push-notifications'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { SettingsAvatarSection } from '@/components/settings-avatar-section'
import { LogoutButton } from '@/components/logout-button'
import { useTranslation } from '@/hooks/use-translation'
import { patchMyProfile } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import { useThemeStore, THEMES, type ThemeId } from '@/store/themeStore'

type Props = { userId: string; username: string; onClose: () => void }

/** Server JSON must be boolean — no client-side default to visible. */
function readDiscoverableFromPayload(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return false
}

export function SettingsModal({ userId, username, onClose }: Props) {
  const { module: locale, setModule: setLocale, t } = useTranslation()
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
  const [settingsTab, setSettingsTab] = useState<'main' | 'profile' | 'media' | 'devices' | 'security'>(
    'main'
  )
  const [changePinOpen, setChangePinOpen] = useState(false)
  const [changePinOld, setChangePinOld] = useState('')
  const [changePinNew, setChangePinNew] = useState('')
  const [changePinConfirm, setChangePinConfirm] = useState('')
  const [changePinBusy, setChangePinBusy] = useState(false)
  const [changePinSuccess, setChangePinSuccess] = useState(false)
  const [killOpen, setKillOpen] = useState(false)
  const [killPhrase, setKillPhrase] = useState('')
  const [killPin, setKillPin] = useState('')
  const [allowNewDeviceLinking, setAllowNewDeviceLinking] = useState(false)
  const [autoLockTimeout, setAutoLockTimeoutState] = useState<AutoLockTimeout>(() => loadAutoLockTimeout())
  const [bio, setBio] = useState('')
  const [statusText, setStatusText] = useState('')
  const [socialLinks, setSocialLinks] = useState<Array<{ platform: string; url: string }>>([])
  const [profileBusy, setProfileBusy] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [lastSeenPrivacy, setLastSeenPrivacy] = useState<'everyone' | 'contacts' | 'nobody'>('everyone')
  const [disableReadReceipts, setDisableReadReceipts] = useState<boolean | null>(null)
  const [blockedUsers, setBlockedUsers] = useState<Array<{ user_id: string; username: string; avatar_key: string | null; blocked_at: string }>>([])
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [loginHistory, setLoginHistory] = useState<Array<{ id: string; outcome: string; ip_address: string | null; user_agent: string | null; created_at: string }>>([])
  const [loginHistoryLoading, setLoginHistoryLoading] = useState(false)

  const chatSoundEnabled = useChatStore((s) => s.chatSoundEnabled)
  const setChatSoundEnabled = useChatStore((s) => s.setChatSoundEnabled)

  const { theme, setTheme } = useThemeStore()

  const loadSettingsFromApi = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch(`${API_URL}/users/me/settings`, {
        credentials: 'include',
      })
      const d = (await r.json().catch(() => ({}))) as {
        is_discoverable?: unknown
        hide_presence?: unknown
        disable_read_receipts?: unknown
        bio?: string | null
        status_text?: string | null
        display_name?: string | null
        last_seen_privacy?: string | null
        social_links?: Array<{ platform: string; url: string }>
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
      setDisableReadReceipts(typeof d.disable_read_receipts === 'boolean' ? d.disable_read_receipts : false)
      setBio(d.bio ?? '')
      setStatusText(d.status_text ?? '')
      setDisplayName(d.display_name ?? '')
      setLastSeenPrivacy(
        d.last_seen_privacy === 'contacts' ? 'contacts'
          : d.last_seen_privacy === 'nobody' ? 'nobody'
          : 'everyone'
      )
      setSocialLinks(Array.isArray(d.social_links) ? d.social_links : [])
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

  async function changeVaultPin() {
    setError(null)
    if (changePinNew.length < 6) {
      setError(t('settings.changePinMinLength'))
      return
    }
    if (changePinNew === changePinOld) {
      setError(t('settings.changePinSameAsOld'))
      return
    }
    if (changePinNew !== changePinConfirm) {
      setError(t('login.vaultPasswordMismatch'))
      return
    }
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError(t('settings.noLocalVault'))
      return
    }
    setChangePinBusy(true)
    try {
      const jwkString = await unwrapPrivateJwkWithPin(blob, changePinOld)
      const newBlob = await wrapPrivateJwkWithPin(jwkString, changePinNew)
      const result = await changeVaultPinOnServer({
        encrypted_blob: JSON.stringify(newBlob),
      })
      if (!result.ok) {
        throw new Error(result.error ?? 'CHANGE_PIN_FAILED')
      }
      persistVaultBlob(userId, newBlob)
      persistVaultBlobByLoginUsername(username, newBlob)
      setChangePinOld('')
      setChangePinNew('')
      setChangePinConfirm('')
      setChangePinOpen(false)
      setChangePinSuccess(true)
      setTimeout(() => setChangePinSuccess(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setChangePinBusy(false)
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

  async function toggleReadReceipts() {
    if (disableReadReceipts === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = !disableReadReceipts
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable_read_receipts: next }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        disable_read_receipts?: unknown
        error?: string
      }
      if (!r.ok) throw new Error(d.error ?? t('settings.toggleFailed'))
      if (typeof d.disable_read_receipts !== 'boolean') throw new Error(t('settings.toggleFailed'))
      setDisableReadReceipts(d.disable_read_receipts)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusy(false)
    }
  }

  async function loadBlockedUsers() {
    setBlockedLoading(true)
    try {
      const r = await fetch(`${API_URL}/users/me/blocked`, { credentials: 'include' })
      const d = (await r.json().catch(() => ({}))) as {
        blocked?: Array<{ user_id: string; username: string; avatar_key: string | null; blocked_at: string }>
      }
      if (r.ok && d.blocked) setBlockedUsers(d.blocked)
    } catch { /* ignore */ } finally {
      setBlockedLoading(false)
    }
  }

  async function unblockUser(targetId: string) {
    try {
      await fetch(`${API_URL}/users/me/block/${targetId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      setBlockedUsers((prev) => prev.filter((u) => u.user_id !== targetId))
    } catch { /* ignore */ }
  }

  async function loadLoginHistory() {
    setLoginHistoryLoading(true)
    try {
      const r = await fetch(`${API_URL}/users/me/login-history`, { credentials: 'include' })
      const d = (await r.json().catch(() => ({}))) as {
        events?: Array<{ id: string; outcome: string; ip_address: string | null; user_agent: string | null; created_at: string }>
      }
      if (r.ok && d.events) setLoginHistory(d.events)
    } catch { /* ignore */ } finally {
      setLoginHistoryLoading(false)
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
    const expected = t('settings.killPhraseExpected')
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

  function _exportVault() {
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
        className={`terminal-panel flex max-h-[min(92dvh,92vh)] w-full min-w-0 flex-col overflow-hidden ${settingsTab === 'media' || settingsTab === 'devices' || settingsTab === 'security' ? 'max-w-2xl' : settingsTab === 'profile' ? 'max-w-lg' : totpSetup ? 'max-w-lg' : 'max-w-md'}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-2 border-b border-neon-red/40 pb-3">
          <p className="min-w-0 break-words text-xs uppercase tracking-[0.35em] text-neon-cyan">
            {t('common.settings')} :: {username}
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
            onClick={() => setSettingsTab('profile')}
            className={`${settingsBtn} hover:scale-[1.02] active:scale-95 ${
              settingsTab === 'profile'
                ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                : 'border-zinc-700 bg-black text-zinc-500 hover:border-neon-cyan/50'
            }`}
          >
            [ {t('profile.section')} ]
          </button>
          <button
            type="button"
            onClick={() => setSettingsTab('security')}
            className={`${settingsBtn} hover:scale-[1.02] active:scale-95 ${
              settingsTab === 'security'
                ? 'border-neon-red bg-neon-red/10 text-neon-red'
                : 'border-zinc-700 bg-black text-zinc-500 hover:border-neon-cyan/50'
            }`}
          >
            [ {t('settings.tabSecurity')} ]
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

        {settingsTab === 'security' ? (
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-widest text-neon-red">
              {t('settings.totpSection')}
            </p>

            {/* TOTP Section */}
            <div className="border border-neon-cyan/30 p-3">
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
                          {t('common.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTotpDisableOpen(false)
                            setTotpDisableCode('')
                          }}
                          className="flex-1 border border-neon-cyan/40 py-1 font-mono text-[10px] text-neon-cyan"
                        >
                          {t('common.cancel')}
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

            {/* Change Vault PIN */}
            <div className="border border-neon-cyan/30 p-3">
              <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">
                {t('settings.changePinTitle')}
              </p>
              <p className="mb-3 text-[9px] text-red-800">{t('settings.changePinHint')}</p>
              {!changePinOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setChangePinOpen(true)
                    setChangePinOld('')
                    setChangePinNew('')
                    setChangePinConfirm('')
                    setError(null)
                  }}
                  className="w-full border border-neon-cyan bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
                >
                  [ {t('settings.changePinAction')} ]
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="terminal-label" htmlFor="change-pin-old">
                    {t('settings.changePinOld')}
                  </label>
                  <input
                    id="change-pin-old"
                    type="password"
                    className="terminal-input text-[10px]"
                    value={changePinOld}
                    onChange={(e) => setChangePinOld(e.target.value)}
                    autoComplete="off"
                  />
                  <label className="terminal-label" htmlFor="change-pin-new">
                    {t('settings.changePinNew')}
                  </label>
                  <input
                    id="change-pin-new"
                    type="password"
                    className="terminal-input text-[10px]"
                    value={changePinNew}
                    onChange={(e) => setChangePinNew(e.target.value)}
                    autoComplete="off"
                  />
                  <label className="terminal-label" htmlFor="change-pin-confirm">
                    {t('settings.changePinConfirmLabel')}
                  </label>
                  <input
                    id="change-pin-confirm"
                    type="password"
                    className="terminal-input text-[10px]"
                    value={changePinConfirm}
                    onChange={(e) => setChangePinConfirm(e.target.value)}
                    autoComplete="off"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={changePinBusy}
                      onClick={() => void changeVaultPin()}
                      className="flex-1 border border-neon-cyan bg-black py-1 font-mono text-[10px] uppercase text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
                    >
                      {changePinBusy ? '[ ... ]' : `[ ${t('common.confirm')} ]`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChangePinOpen(false)
                        setChangePinOld('')
                        setChangePinNew('')
                        setChangePinConfirm('')
                      }}
                      className="flex-1 border border-zinc-600 py-1 font-mono text-[10px] text-zinc-400"
                    >
                      [ {t('common.cancel')} ]
                    </button>
                  </div>
                </div>
              )}
              {changePinSuccess ? (
                <p className="mt-2 text-[10px] text-neon-cyan">:: {t('settings.changePinSuccess')}</p>
              ) : null}
            </div>

            {/* Auto-lock timeout */}
            <div className="flex flex-col gap-2 border border-neon-cyan/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-widest text-neon-cyan">
                  {t('settings.autoLockTitle')}
                </p>
                <p className="break-words text-[9px] text-red-800">
                  {t('settings.autoLockHint')}
                </p>
              </div>
              <select
                className="terminal-input h-8 w-full max-w-[10rem] shrink-0 py-1 text-xs uppercase"
                value={autoLockTimeout}
                onChange={(e) => {
                  const val = Number(e.target.value) as AutoLockTimeout
                  setAutoLockTimeoutState(val)
                  saveAutoLockTimeout(val)
                }}
                aria-label={t('settings.autoLockTitle')}
              >
                {AUTO_LOCK_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey as Parameters<typeof t>[0])}
                  </option>
                ))}
              </select>
            </div>

            {/* Device Linking Gate */}
            <div className="flex flex-col gap-2 border border-neon-cyan/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-widest text-neon-cyan">
                  {t('common.deviceLinking')}
                </p>
                <p className="break-words text-[9px] text-red-800">
                  {allowNewDeviceLinking
                    ? 'ON'
                    : 'OFF'}
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

            {/* Privacy: Read Receipts Toggle */}
            <div className="border border-neon-cyan/30 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-widest text-neon-cyan">
                    {t('privacy.readReceipts')}
                  </p>
                  <p className="break-words text-[9px] text-red-800">
                    {t('privacy.readReceiptsHint')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={disableReadReceipts === true}
                  disabled={busy || disableReadReceipts === null}
                  onClick={() => void toggleReadReceipts()}
                  className={`shrink-0 border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                    disableReadReceipts === null
                      ? 'border-zinc-700 bg-zinc-950 text-zinc-600'
                      : disableReadReceipts
                        ? 'border-neon-red bg-neon-red/10 text-neon-red shadow-[0_0_14px_rgba(239,68,68,0.25)]'
                        : 'border-zinc-600 bg-zinc-950 text-zinc-400'
                  } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}
                >
                  {busy ? '[ … ]' : disableReadReceipts === null ? '[ -- ]' : disableReadReceipts ? '[ OFF ]' : '[ ON ]'}
                </button>
              </div>
            </div>

            {/* Privacy: Blocked Users */}
            <div className="border border-neon-cyan/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs uppercase tracking-widest text-neon-cyan">
                    {t('block.title')}
                  </p>
                  <p className="text-[9px] text-red-800">{t('block.hint')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadBlockedUsers()}
                  disabled={blockedLoading}
                  className="shrink-0 border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10 disabled:opacity-40"
                >
                  {blockedLoading ? '[ ... ]' : '[ LOAD ]'}
                </button>
              </div>
              {blockedUsers.length === 0 ? (
                <p className="text-[9px] text-zinc-600">{t('block.empty')}</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {blockedUsers.map((u) => (
                    <div key={u.user_id} className="flex items-center justify-between border border-zinc-800 px-2 py-1">
                      <span className="font-mono text-[10px] text-neon-cyan/80 truncate">@{u.username}</span>
                      <button
                        type="button"
                        onClick={() => void unblockUser(u.user_id)}
                        className="shrink-0 border border-neon-red/50 px-2 py-0.5 font-mono text-[8px] uppercase text-neon-red hover:bg-neon-red/10"
                      >
                        {t('block.unblock')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Login History */}
            <div className="border border-neon-cyan/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs uppercase tracking-widest text-neon-cyan">
                    {t('security.loginHistory')}
                  </p>
                  <p className="text-[9px] text-red-800">{t('security.loginHistoryHint')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadLoginHistory()}
                  disabled={loginHistoryLoading}
                  className="shrink-0 border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10 disabled:opacity-40"
                >
                  {loginHistoryLoading ? '[ ... ]' : '[ LOAD ]'}
                </button>
              </div>
              {loginHistory.length === 0 ? (
                <p className="text-[9px] text-zinc-600">{t('security.loginNoEvents')}</p>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {loginHistory.slice(0, 10).map((ev) => {
                    const outcomeLabel =
                      ev.outcome === 'success' ? t('security.loginSuccess')
                      : ev.outcome === 'fail_signature' ? t('security.loginFailSignature')
                      : ev.outcome === 'fail_totp' ? t('security.loginFailTotp')
                      : ev.outcome === 'fail_banned' ? t('security.loginFailBanned')
                      : ev.outcome === 'fail_device_revoked' ? t('security.loginFailDeviceRevoked')
                      : ev.outcome
                    const isSuccess = ev.outcome === 'success'
                    return (
                      <div key={ev.id} className="border border-zinc-800 px-2 py-1">
                        <div className="flex items-center justify-between">
                          <span className={`font-mono text-[9px] uppercase tracking-wider ${isSuccess ? 'text-neon-cyan' : 'text-neon-red'}`}>
                            {outcomeLabel}
                          </span>
                          <span className="font-mono text-[8px] text-zinc-500">
                            {new Date(ev.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="font-mono text-[8px] text-zinc-600 truncate">
                          {ev.ip_address ?? '—'} · {ev.user_agent?.slice(0, 60) ?? '—'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* INCINERATE_LOCAL_DATA */}
            <div className="border-t border-red-600/50 pt-3">
              <button
                type="button"
                onClick={() => setKillOpen((v) => !v)}
                className="glitch-text mb-2 w-full border border-red-600 bg-black py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-red-500 hover:bg-red-950/40"
              >
                {t('settings.killExecute')}
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
        ) : null}

        {settingsTab === 'media' ? <SettingsMediaPanel active /> : null}
        {settingsTab === 'devices' ? (
          <SettingsDevicesPanel userId={userId} active />
        ) : null}

        {settingsTab === 'profile' ? (
          <div className="space-y-4">
            {/* Avatar */}
            <SettingsAvatarSection userId={userId} username={username} />

            {/* Display Name */}
            <div className="border border-neon-cyan/30 p-3 space-y-2">
              <label className="terminal-label" htmlFor="profile-display-name">
                {t('profile.editName')}
              </label>
              <input
                id="profile-display-name"
                className="terminal-input text-[10px]"
                maxLength={64}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={username}
              />
            </div>

            {/* @username (read-only) */}
            <div className="border border-neon-cyan/30 p-3 space-y-1">
              <p className="terminal-label">@{t('common.peerInputAria')}</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-neon-cyan/70">@{username}</span>
                <span className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">
                  ({t('profile.readOnly')})
                </span>
              </div>
            </div>

            {/* Bio */}
            <div className="border border-neon-cyan/30 p-3 space-y-2">
              <label className="terminal-label" htmlFor="profile-bio-tab">
                {t('profile.bio')}
              </label>
              <textarea
                id="profile-bio-tab"
                className="terminal-input mt-1 min-h-[5rem] w-full resize-y text-[10px]"
                maxLength={500}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t('profile.bioPlaceholder')}
              />
              <p className={`text-right font-mono text-[8px] ${bio.length > 450 ? 'text-neon-red' : 'text-zinc-600'}`}>
                {bio.length}/500
              </p>
            </div>

            {/* Status text */}
            <div className="border border-neon-cyan/30 p-3 space-y-2">
              <label className="terminal-label" htmlFor="profile-status-tab">
                {t('profile.statusText')}
              </label>
              <input
                id="profile-status-tab"
                className="terminal-input text-[10px]"
                maxLength={128}
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                placeholder={t('profile.statusPlaceholder')}
              />
              <div className="flex flex-wrap gap-1 mt-1">
                <p className="w-full text-[8px] uppercase tracking-widest text-zinc-600">{t('profile.statusPresets')}:</p>
                {[
                  { label: t('profile.online'), value: '' },
                  { label: t('profile.busy'), value: 'busy' },
                  { label: t('profile.doNotDisturb'), value: 'do not disturb' },
                  { label: 'DEAD_INSIDE', value: 'dead_inside' },
                ].map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => setStatusText(preset.value)}
                    className={`border px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest transition-colors ${
                      statusText === preset.value
                        ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                        : 'border-zinc-700 text-zinc-500 hover:border-neon-cyan/50'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Last Seen Privacy */}
            <div className="border border-neon-cyan/30 p-3 space-y-2">
              <p className="terminal-label">{t('profile.lastSeenSettings')}</p>
              <p className="text-[9px] text-red-800">{t('profile.lastSeenPrivacyHint')}</p>
              <div className="flex flex-wrap gap-2">
                {(['everyone', 'contacts', 'nobody'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setLastSeenPrivacy(opt)}
                    className={`border px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors ${
                      lastSeenPrivacy === opt
                        ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                        : 'border-zinc-700 text-zinc-500 hover:border-neon-cyan/50'
                    }`}
                  >
                    {t(`profile.lastSeen${opt.charAt(0).toUpperCase() + opt.slice(1)}` as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>
            </div>

            {/* Social Links */}
            <div className="border border-neon-cyan/30 p-3 space-y-2">
              <p className="terminal-label">{t('profile.socialLinks')}</p>
              <div className="space-y-2">
                {socialLinks.map((link, idx) => (
                  <div key={idx} className="flex gap-2">
                    <select
                      className="terminal-input w-28 text-[10px]"
                      value={link.platform}
                      onChange={(e) => {
                        const next = [...socialLinks]
                        next[idx] = { ...next[idx], platform: e.target.value }
                        setSocialLinks(next)
                      }}
                    >
                      <option value="telegram">Telegram</option>
                      <option value="github">GitHub</option>
                      <option value="website">Website</option>
                    </select>
                    <input
                      className="terminal-input flex-1 text-[10px]"
                      value={link.url}
                      onChange={(e) => {
                        const next = [...socialLinks]
                        next[idx] = { ...next[idx], url: e.target.value }
                        setSocialLinks(next)
                      }}
                      placeholder={t('profile.url')}
                    />
                    <button
                      type="button"
                      onClick={() => setSocialLinks(socialLinks.filter((_, i) => i !== idx))}
                      className="shrink-0 border border-neon-red/50 px-2 py-1 font-mono text-[9px] text-neon-red hover:bg-neon-red/10"
                    >
                      [X]
                    </button>
                  </div>
                ))}
                {socialLinks.length < 5 ? (
                  <button
                    type="button"
                    onClick={() => setSocialLinks([...socialLinks, { platform: 'telegram', url: '' }])}
                    className="w-full border border-neon-cyan/40 bg-black py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10"
                  >
                    + {t('profile.addLink')}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Save Profile */}
            <button
              type="button"
              disabled={profileBusy}
              onClick={() => {
                setProfileBusy(true)
                setError(null)
                void patchMyProfile({
                  bio,
                  status_text: statusText,
                  display_name: displayName || undefined,
                  last_seen_privacy: lastSeenPrivacy,
                  social_links: socialLinks.filter((l) => l.url.trim()),
                })
                  .then(() => {
                    setSaved(true)
                    setTimeout(() => setSaved(false), 1500)
                  })
                  .catch((e) => {
                    setError(e instanceof Error ? e.message : t('profile.saveFailed'))
                  })
                  .finally(() => setProfileBusy(false))
              }}
              className="w-full border border-neon-cyan bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
            >
              {profileBusy ? '[ ... ]' : `[ ${t('profile.saveProfile')} ]`}
            </button>

            {/* Danger Zone */}
            <div className="border-t border-neon-red/40 pt-3 space-y-3">
              <p className="text-xs uppercase tracking-widest text-neon-red">
                {t('profile.dangerZone')}
              </p>
              <button
                type="button"
                onClick={() => setSettingsTab('security')}
                className="w-full border border-neon-red/50 bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red/70 hover:bg-neon-red/10 hover:text-neon-red transition-colors"
              >
                [ {t('profile.changePassword')} ]
              </button>
              <button
                type="button"
                onClick={() => {
                  setKillOpen(true)
                  setSettingsTab('security')
                }}
                className="w-full border border-red-600 bg-black py-2 font-mono text-[10px] uppercase tracking-widest text-red-500 hover:bg-red-950/40 transition-colors"
              >
                [ {t('profile.deleteAccount')} ]
              </button>
            </div>
          </div>
        ) : null}

        <div
          className={`space-y-3 ${settingsTab !== 'main' ? 'hidden' : ''}`}
        >
          <SettingsPushNotifications userId={userId} />

          {/* Chat Sound Toggle */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('settings.chatSoundTitle')}
              </p>
              <p className="break-words text-[9px] text-red-800">
                {t('settings.chatSoundHint')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={chatSoundEnabled}
              onClick={() => setChatSoundEnabled(!chatSoundEnabled)}
              className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                chatSoundEnabled
                  ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                  : 'border-zinc-600 bg-zinc-950 text-zinc-400'
              } hover:border-neon-red hover:text-neon-red`}
            >
              {chatSoundEnabled ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>

          {/* ===== CHROMATIC_PROTOCOL :: THEME PICKER ===== */}
          <div className="space-y-2 border-t border-neon-cyan/20 pt-3">
            <p className="text-xs uppercase tracking-widest text-neon-cyan">
              // CHROMATIC_PROTOCOL :: VISUAL THEME
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              {THEMES.map((t_cfg) => (
                <button
                  key={t_cfg.id}
                  type="button"
                  onClick={() => setTheme(t_cfg.id as ThemeId)}
                  className={`flex items-center gap-3 border px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest transition-all duration-150 ${
                    theme === t_cfg.id
                      ? 'border-neon-cyan text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.2)]'
                      : 'border-neon-red/25 text-neon-red/50 hover:border-neon-red/60 hover:text-neon-red'
                  }`}
                >
                  <span className="flex shrink-0 gap-1">
                    <span className="h-3 w-3 border border-white/10" style={{ background: t_cfg.bg }} />
                    <span className="h-3 w-3 border border-white/10" style={{ background: t_cfg.primary }} />
                    <span className="h-3 w-3 border border-white/10" style={{ background: t_cfg.accent }} />
                  </span>
                  {t_cfg.label}
                  {theme === t_cfg.id && <span className="ml-auto text-neon-cyan">◆</span>}
                </button>
              ))}
            </div>
          </div>
          {/* ===== END CHROMATIC_PROTOCOL ===== */}

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

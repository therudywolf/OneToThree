'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
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
import { SettingsChatFoldersPanel } from '@/components/settings-chat-folders-panel'
import { SettingsStickersPanel } from '@/components/settings-stickers-panel'
import { useCapabilities } from '@/components/capabilities-provider'
import { LogoutButton } from '@/components/logout-button'
import { useTranslation } from '@/hooks/use-translation'
import { patchMyProfile, deleteMyAccount } from '@/lib/api/users'
import { fetchChatsList } from '@/lib/api/chats'
import { useChatStore } from '@/store/chatStore'
import { CHAT_SOUND_SCHEMES, type ChatSoundSchemeId } from '@/store/chatStore'
import {
  ACCENT_PRESETS,
  resolveThemeAppearance,
  useThemeStore,
  THEMES,
  type ThemeId,
  type MotionMode,
  type PlatformProfileId,
} from '@/store/themeStore'
import { VaultPinGate } from '@/components/vault-pin-gate'
import { QRCodeSVG } from 'qrcode.react'
import { prepareRecoveryEnrollment, commitRecoveryEnrollment } from '@/lib/recovery/enroll-recovery'
import { clearBackupPending } from '@/lib/backup-reminder'
import { getRecoveryStatus, getRecoverySetupChallenge, disableRecovery, type RecoveryStatus } from '@/lib/api/recovery'
import { importEcdsaPrivateKeyForSign, signUtf8WithEcdsaP256 } from '@/lib/crypto'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import { getTrustedPeerCount } from '@/lib/trust-store'
import { PortalRoot } from '@/components/portal-root'
import { acquireBodyScrollLock } from '@/lib/body-scroll-lock'
import { explainSettingsError } from '@/lib/settings-errors'

type Props = { userId: string; username: string; onClose: () => void }
type SettingsTabId =
  | 'main'
  | 'chat'
  | 'profile'
  | 'media'
  | 'devices'
  | 'security'
  | 'folders'
  | 'stickers'

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; labelKey: string }> = [
  { id: 'main', labelKey: 'settings.tabGeneral' },
  { id: 'chat', labelKey: 'settings.tabChats' },
  { id: 'profile', labelKey: 'profile.section' },
  { id: 'folders', labelKey: 'settings.tabFolders' },
  { id: 'stickers', labelKey: 'settings.tabStickers' },
  { id: 'security', labelKey: 'settings.tabSecurity' },
  { id: 'media', labelKey: 'settings.tabMedia' },
  { id: 'devices', labelKey: 'settings.tabDevices' },
]

/**
 * SECURITY GATES (vault-password required):
 *   - Export vault key
 *   - Enable TOTP
 *   - Disable TOTP
 *   - Enable device linking
 *
 * No vault-password required:
 *   - Profile edits (bio, display name, etc.)
 *   - Appearance / language
 *   - Privacy toggles (discoverable, presence, read receipts)
 */

/** Server JSON must be boolean — no client-side default to visible. */
function readDiscoverableFromPayload(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return false
}

type VaultGateTarget = 'export' | 'totp_setup' | 'totp_disable' | 'device_linking_on' | 'recovery_enable' | 'recovery_disable' | null
type AppearanceStyleId = 'terminal' | 'md3' | 'retro'

export function SettingsModal({ userId, username, onClose }: Props) {
  const modalRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const { module: locale, setModule: setLocale, t } = useTranslation()
  // D18 — keep a ref to the latest translator so loadSettingsFromApi can read
  // current copy WITHOUT taking `t` as a dep. With `t` in its deps, switching
  // the UI language re-minted loadSettingsFromApi → re-fired the load effect →
  // clobbered unsaved profile edits (display name / bio / status).
  const tRef = useRef(t)
  tRef.current = t
  const { user, updateUser, refresh } = useAuth()
  const capabilities = useCapabilities()
  // Hide tabs for features this instance disabled (Lite self-host). The Media
  // tab (camera/mic device pickers + attachment cache) is relevant if EITHER
  // media or calls is on; hide it only when both are off.
  const visibleTabs = SETTINGS_TABS.filter((tab) => {
    if (tab.id === 'stickers') return capabilities.stickers
    if (tab.id === 'media') return capabilities.media || capabilities.calls
    return true
  })
  const [discoverable, setDiscoverable] = useState<boolean | null>(null)
  const [hidePresence, setHidePresence] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [totpSetup, setTotpSetup] = useState<{ qr_data_url: string; secret: string } | null>(null)
  const [totpEnableCode, setTotpEnableCode] = useState('')
  const [totpDisableCode, setTotpDisableCode] = useState('')
  const [totpBusy, setTotpBusy] = useState(false)
  const [totpDisableOpen, setTotpDisableOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('main')
  const [mobileSettingsView, setMobileSettingsView] = useState<'list' | SettingsTabId>('list')
  const [changePinOpen, setChangePinOpen] = useState(false)
  const [changePinOld, setChangePinOld] = useState('')
  const [changePinNew, setChangePinNew] = useState('')
  const [changePinConfirm, setChangePinConfirm] = useState('')
  const [changePinBusy, setChangePinBusy] = useState(false)
  const [changePinSuccess, setChangePinSuccess] = useState(false)
  const [killOpen, setKillOpen] = useState(false)
  const [killPhrase, setKillPhrase] = useState('')
  const [killPin, setKillPin] = useState('')
  // D7 — TOTP step-up for the real account-delete call. When the server
  // challenges (TOTP enabled), reveal a 6-digit code field and retry.
  const [killTotpRequired, setKillTotpRequired] = useState(false)
  const [killTotpCode, setKillTotpCode] = useState('')
  const [allowNewDeviceLinking, setAllowNewDeviceLinking] = useState(false)
  const [autoLockTimeout, setAutoLockTimeoutState] = useState<AutoLockTimeout>(() => loadAutoLockTimeout())
  const [bio, setBio] = useState('')
  const [statusText, setStatusText] = useState('')
  const [socialLinks, setSocialLinks] = useState<Array<{ platform: string; url: string }>>([])
  const [profileBusy, setProfileBusy] = useState(false)
  const [myLinkCopied, setMyLinkCopied] = useState(false)
  const myInviteLink = typeof window === 'undefined' ? '' : `${window.location.origin}/?invite=${encodeURIComponent(userId)}`
  // Personal channel pinned to the profile («стена»). '' = not linked.
  const [profileChannelId, setProfileChannelId] = useState('')
  const [myChannels, setMyChannels] = useState<Array<{ id: string; name: string | null }>>([])
  const [channelSaveBusy, setChannelSaveBusy] = useState(false)

  useEffect(() => {
    void fetchChatsList()
      .then((rows) => {
        setMyChannels(
          rows
            .filter((r) => r.type === 'channel' && r.my_role === 'owner')
            .map((r) => ({ id: r.id, name: r.name ?? null }))
        )
      })
      .catch(() => setMyChannels([]))
  }, [userId])

  const saveProfileChannel = async (next: string) => {
    const prev = profileChannelId
    setProfileChannelId(next)
    setChannelSaveBusy(true)
    try {
      await patchMyProfile({ profile_channel_id: next === '' ? null : next })
    } catch (e) {
      setProfileChannelId(prev)
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'profile.saveFailed'))
    } finally {
      setChannelSaveBusy(false)
    }
  }
  const [displayName, setDisplayName] = useState('')
  const [lastSeenPrivacy, setLastSeenPrivacy] = useState<'everyone' | 'contacts' | 'nobody'>('everyone')
  const [disableReadReceipts, setDisableReadReceipts] = useState<boolean | null>(null)
  const [blockedUsers, setBlockedUsers] = useState<Array<{ user_id: string; username: string; avatar_key: string | null; blocked_at: string }>>([])
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [loginHistory, setLoginHistory] = useState<Array<{ id: string; outcome: string; ip_address: string | null; user_agent: string | null; created_at: string }>>([])
  const [loginHistoryLoading, setLoginHistoryLoading] = useState(false)

  /** Pending vault-gate action — null = gate closed */
  const [vaultGate, setVaultGate] = useState<VaultGateTarget>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null)
  const [recoveryEnable, setRecoveryEnable] = useState<{ mnemonic: string; recoveryBlob: string; publicJwk: string; ecdsaPrivateJwk: string } | null>(null)
  const [recoveryRequireTotp, setRecoveryRequireTotp] = useState(false)
  const [recoverySavedConfirmed, setRecoverySavedConfirmed] = useState(false)
  const [recoveryShowQr, setRecoveryShowQr] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoverySuccess, setRecoverySuccess] = useState(false)

  const chatSoundEnabled = useChatStore((s) => s.chatSoundEnabled)
  const setChatSoundEnabled = useChatStore((s) => s.setChatSoundEnabled)
  const chatSoundScheme = useChatStore((s) => s.chatSoundScheme)
  const setChatSoundScheme = useChatStore((s) => s.setChatSoundScheme)
  const {
    theme,
    setTheme,
    shellMode,
    setShellMode,
    platformProfile,
    setPlatformProfile,
    accentPreset,
    setAccentPreset,
    primaryColorOverride,
    setPrimaryColorOverride,
    accentColorOverride,
    setAccentColorOverride,
    accentSoftColorOverride,
    setAccentSoftColorOverride,
    backgroundColorOverride,
    setBackgroundColorOverride,
    motionMode,
    setMotionMode,
    resetAppearance,
  } = useThemeStore()
  const isMd3 = shellMode === 'md3'
  const isRetro = shellMode === 'terminal' && theme === 'retro'
  const appearanceStyle: AppearanceStyleId =
    shellMode === 'md3' ? 'md3' : theme === 'retro' ? 'retro' : 'terminal'
  const appearanceStyles: ReadonlyArray<{
    id: AppearanceStyleId
    label: string
    hint: string
  }> = [
    {
      id: 'terminal',
      label: t('settings.appearanceShellTerminal'),
      hint: t('settings.appearanceShellTerminalHint'),
    },
    {
      id: 'md3',
      label: t('settings.appearanceShellMd3'),
      hint: t('settings.appearanceShellMd3Hint'),
    },
    {
      id: 'retro',
      label: t('settings.appearanceShellRetro'),
      hint: t('settings.appearanceShellRetroHint'),
    },
  ]
  const platformProfiles: ReadonlyArray<{
    id: PlatformProfileId
    label: string
    hint: string
  }> = [
    {
      id: 'desktop-tg',
      label: t('settings.appearancePlatformDesktop'),
      hint: t('settings.appearancePlatformDesktopHint'),
    },
    {
      id: 'mobile-tg-ios',
      label: t('settings.appearancePlatformMobile'),
      hint: t('settings.appearancePlatformMobileHint'),
    },
  ]
  const palettesForStyle = useMemo(() => {
    if (appearanceStyle === 'retro') return THEMES.filter((cfg) => cfg.id === 'retro')
    if (appearanceStyle === 'terminal') {
      return THEMES.filter((cfg) => cfg.id !== 'md3dark' && cfg.id !== 'md3light' && cfg.id !== 'retro')
    }
    return THEMES.filter((cfg) => cfg.id !== 'retro')
  }, [appearanceStyle])

  const loadSettingsFromApi = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch(`${API_URL}/users/me/settings`, { credentials: 'include' })
      const d = (await r.json().catch(() => ({}))) as {
        is_discoverable?: unknown; hide_presence?: unknown; disable_read_receipts?: unknown; allow_device_linking?: unknown
        bio?: string | null; status_text?: string | null; display_name?: string | null
        last_seen_privacy?: string | null
        social_links?: Array<{ platform: string; url: string }>; error?: string
        profile_channel_id?: string | null
      }
      if (!r.ok) { setError(explainSettingsError(d.error ?? '', tRef.current, 'settings.loadFailed')); return }
      const value = readDiscoverableFromPayload(d.is_discoverable)
      setDiscoverable(value)
      updateUser({ is_discoverable: value })
      setHidePresence(typeof d.hide_presence === 'boolean' ? d.hide_presence : false)
      setDisableReadReceipts(typeof d.disable_read_receipts === 'boolean' ? d.disable_read_receipts : false)
      setAllowNewDeviceLinking(typeof d.allow_device_linking === 'boolean' ? d.allow_device_linking : false)
      setBio(d.bio ?? '')
      setStatusText(d.status_text ?? '')
      setDisplayName(d.display_name ?? '')
      setLastSeenPrivacy(
        d.last_seen_privacy === 'contacts' ? 'contacts'
          : d.last_seen_privacy === 'nobody' ? 'nobody'
          : 'everyone'
      )
      setSocialLinks(Array.isArray(d.social_links) ? d.social_links : [])
      setProfileChannelId(typeof d.profile_channel_id === 'string' ? d.profile_channel_id : '')
    } catch { setError(tRef.current('settings.loadFailed')) }
  }, [updateUser])

  useEffect(() => { void loadSettingsFromApi() }, [userId, loadSettingsFromApi])

  useEffect(() => acquireBodyScrollLock(), [])

  useEffect(() => {
    void (async () => {
      try {
        const { user: u } = await fetchMe()
        updateUser({ totp_enabled: u.totp_enabled })
      } catch { /* ignore */ }
    })()
  }, [userId, updateUser])

  // ── Vault gate handler ──────────────────────────────────────────────────────
  function handleVaultGateVerified(pin: string) {
    const target = vaultGate
    setVaultGate(null)
    if (target === 'export')           { execExportVault(); return }
    if (target === 'totp_setup')       { void startTotpSetup(); return }
    if (target === 'totp_disable')     { setTotpDisableOpen(true); return }
    if (target === 'device_linking_on') { void setDeviceLinking(true); return }
    if (target === 'recovery_enable')   { void beginRecoveryEnable(pin); return }
    if (target === 'recovery_disable')  { void beginRecoveryDisable(pin); return }
  }

  function gateActionLabel(target: VaultGateTarget): string {
    if (target === 'export')            return t('settings.exportVaultAction')
    if (target === 'totp_setup')        return t('settings.totpSetupGateLabel')
    if (target === 'totp_disable')      return t('settings.totpDisableGateLabel')
    if (target === 'device_linking_on') return t('settings.deviceLinkingGateLabel')
    if (target === 'recovery_enable')   return t('settings.recoveryGateLabel')
    if (target === 'recovery_disable')  return t('settings.recoveryDisableGateLabel')
    return ''
  }

  // ── TOTP ────────────────────────────────────────────────────────────────────
  async function startTotpSetup() {
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/setup`, { method: 'POST', credentials: 'include' })
      const d = (await r.json().catch(() => ({}))) as { qr_data_url?: string; secret?: string; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'SETUP_FAILED')
      if (!d.qr_data_url || !d.secret) throw new Error('INVALID_SETUP_RESPONSE')
      setTotpSetup({ qr_data_url: d.qr_data_url, secret: d.secret })
      setTotpEnableCode('')
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setTotpBusy(false) }
  }

  async function confirmTotpSetup() {
    const digits = totpEnableCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length !== 6) { setError(t('login.totpSixDigits')); return }
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/verify-setup`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits }),
      })
      const d = (await r.json().catch(() => ({}))) as { totp_enabled?: boolean; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'VERIFY_SETUP_FAILED')
      setTotpSetup(null)
      setTotpEnableCode('')
      updateUser({ totp_enabled: true })
      await refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setTotpBusy(false) }
  }

  async function disableTotp() {
    const digits = totpDisableCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length !== 6) { setError(t('login.totpSixDigits')); return }
    setTotpBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/auth/2fa/disable`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits }),
      })
      const d = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) throw new Error(d.error ?? 'DISABLE_FAILED')
      setTotpDisableOpen(false)
      setTotpDisableCode('')
      updateUser({ totp_enabled: false })
      await refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setTotpBusy(false) }
  }

  // ── Vault PIN change ─────────────────────────────────────────────────────────
  async function changeVaultPin() {
    setError(null)
    if (changePinNew.length < 6) { setError(t('settings.changePinMinLength')); return }
    if (changePinNew === changePinOld) { setError(t('settings.changePinSameAsOld')); return }
    if (changePinNew !== changePinConfirm) { setError(t('login.vaultPasswordMismatch')); return }
    const blob = readVaultBlob(userId)
    if (!blob) { setError(t('settings.noLocalVault')); return }
    setChangePinBusy(true)
    try {
      const jwkString = await unwrapPrivateJwkWithPin(blob, changePinOld)
      const newBlob = await wrapPrivateJwkWithPin(jwkString, changePinNew)
      // Re-wrapping happens purely on this device. We used to POST the fresh
      // blob to /users/me/vault/change-pin, which parked the complete keyring
      // ciphertext — plus its salt, IV and KDF parameters — in users.vault_blob
      // forever. Nothing ever read that column, so it bought nothing and turned
      // any `users` table dump into an offline brute-force target against a
      // 6-character human password; cracking one yields the ECDSA identity key
      // (account takeover) and the ECDH key (every derived DR prekey).
      persistVaultBlob(userId, newBlob)
      persistVaultBlobByLoginUsername(username, newBlob)
      setChangePinOld('')
      setChangePinNew('')
      setChangePinConfirm('')
      setChangePinOpen(false)
      setChangePinSuccess(true)
      setTimeout(() => setChangePinSuccess(false), 2000)
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setChangePinBusy(false) }
  }

  // ── Account recovery (Option A) ───────────────────────────────────────────────
  // Load current status when the security tab is shown (best-effort).
  useEffect(() => {
    if (settingsTab !== 'security') return
    let cancelled = false
    getRecoveryStatus()
      .then((s) => { if (!cancelled) setRecoveryStatus(s) })
      .catch(() => { /* fall back to the disabled affordance */ })
    return () => { cancelled = true }
  }, [settingsTab])

  // Prove vault-unlock to the server: sign a fresh server nonce with the login
  // device key (the keyring's ECDSA key, recovered from the just-unwrapped
  // keyring). A bare stolen session can't do this, so it can't enable/disable.
  async function signVaultProof(ecdsaPrivateJwk: string): Promise<{ proof_nonce: string; proof_signature: string }> {
    const nonce = await getRecoverySetupChallenge()
    const key = await importEcdsaPrivateKeyForSign(ecdsaPrivateJwk)
    const signature = await signUtf8WithEcdsaP256(key, nonce)
    return { proof_nonce: nonce, proof_signature: signature }
  }

  // Vault password already verified by the gate — re-unwrap the keyring and seal
  // a SECOND copy under a freshly generated recovery phrase. Everything here is
  // client-only; only the ciphertext blob + the phrase-derived public key leave.
  async function beginRecoveryEnable(pin: string) {
    setError(null)
    setRecoveryBusy(true)
    try {
      // Shared with the post-register onboarding step — see lib/recovery/enroll-recovery.
      const enrollment = await prepareRecoveryEnrollment(userId, pin)
      setRecoveryRequireTotp(false)
      setRecoverySavedConfirmed(false)
      setRecoveryShowQr(false)
      setRecoveryEnable(enrollment)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg === 'NO_LOCAL_VAULT') { setError(t('settings.noLocalVault')); return }
      setError(explainSettingsError(msg, t, 'settings.toggleFailed'))
    } finally { setRecoveryBusy(false) }
  }

  async function confirmRecoveryEnable() {
    if (!recoveryEnable) return
    setError(null)
    setRecoveryBusy(true)
    try {
      await commitRecoveryEnrollment(recoveryEnable, recoveryRequireTotp)
      // Enrolling the phrase makes the account genuinely recoverable — the other
      // event (besides saving the key file) that should silence the backup nag.
      // Neither was wired up, so the banner had no way to ever go away.
      if (userId) clearBackupPending(userId)
      setRecoveryEnable(null)
      setRecoverySavedConfirmed(false)
      try { setRecoveryStatus(await getRecoveryStatus()) } catch { /* refreshed lazily */ }
      setRecoverySuccess(true)
      setTimeout(() => setRecoverySuccess(false), 2500)
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setRecoveryBusy(false) }
  }

  function cancelRecoveryEnable() {
    setRecoveryEnable(null)
    setRecoveryRequireTotp(false)
    setRecoverySavedConfirmed(false)
    setRecoveryShowQr(false)
    setError(null)
  }

  async function beginRecoveryDisable(pin: string) {
    setError(null)
    setRecoveryBusy(true)
    try {
      const blob = readVaultBlob(userId)
      if (!blob) { setError(t('settings.noLocalVault')); return }
      const keyring = await unwrapPrivateJwkWithPin(blob, pin)
      const parsed = parseVaultPlaintext(keyring)
      if (!parsed || parsed.kind !== 'V2') throw new Error('INVALID_VAULT_FORMAT')
      await disableRecovery(await signVaultProof(parsed.ecdsaJwk))
      try { setRecoveryStatus(await getRecoveryStatus()) } catch { /* refreshed lazily */ }
    } catch (e) {
      setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed'))
    } finally { setRecoveryBusy(false) }
  }

  function downloadRecoveryPhrase(mnemonic: string) {
    const data = new Blob([mnemonic + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'onetothree-recovery-phrase.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Toggles ──────────────────────────────────────────────────────────────────
  async function toggleHidePresence() {
    if (hidePresence === null || busy) return
    setBusy(true); setError(null)
    try {
      const nextRequest = !hidePresence
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide_presence: nextRequest }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; hide_presence?: unknown; error?: string }
      if (!r.ok) throw new Error(d.error ?? t('settings.toggleFailed'))
      if (typeof d.hide_presence !== 'boolean') throw new Error(t('settings.toggleFailed'))
      setHidePresence(d.hide_presence)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch (e) { setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed')) }
    finally { setBusy(false) }
  }

  async function toggleReadReceipts() {
    if (disableReadReceipts === null || busy) return
    setBusy(true); setError(null)
    try {
      const next = !disableReadReceipts
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable_read_receipts: next }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; disable_read_receipts?: unknown; error?: string }
      if (!r.ok) throw new Error(d.error ?? t('settings.toggleFailed'))
      if (typeof d.disable_read_receipts !== 'boolean') throw new Error(t('settings.toggleFailed'))
      setDisableReadReceipts(d.disable_read_receipts)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch (e) { setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed')) }
    finally { setBusy(false) }
  }

  async function toggleDiscoverable() {
    if (discoverable === null || busy) return
    setBusy(true); setError(null)
    try {
      const nextRequest = !discoverable
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_discoverable: nextRequest }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; is_discoverable?: unknown; error?: string }
      if (!r.ok) throw new Error(d.error ?? t('settings.toggleFailed'))
      if (typeof d.is_discoverable !== 'boolean') throw new Error(t('settings.toggleFailed'))
      setDiscoverable(d.is_discoverable)
      updateUser({ is_discoverable: d.is_discoverable })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch (e) { setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed')) }
    finally { setBusy(false) }
  }

  async function setDeviceLinking(next: boolean) {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_device_linking: next }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; allow_device_linking?: unknown; error?: string }
      if (!r.ok) throw new Error(d.error ?? t('settings.toggleFailed'))
      if (typeof d.allow_device_linking !== 'boolean') throw new Error(t('settings.toggleFailed'))
      setAllowNewDeviceLinking(d.allow_device_linking)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch (e) { setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'settings.toggleFailed')) }
    finally { setBusy(false) }
  }

  // ── Blocked / login history ───────────────────────────────────────────────
  async function loadBlockedUsers() {
    setBlockedLoading(true)
    try {
      const r = await fetch(`${API_URL}/users/me/blocked`, { credentials: 'include' })
      const d = (await r.json().catch(() => ({}))) as {
        blocked?: Array<{ user_id: string; username: string; avatar_key: string | null; blocked_at: string }>
      }
      if (r.ok && d.blocked) setBlockedUsers(d.blocked)
    } catch { /* ignore */ } finally { setBlockedLoading(false) }
  }

  async function unblockUser(targetId: string) {
    try {
      await fetch(`${API_URL}/users/me/block/${targetId}`, { method: 'DELETE', credentials: 'include' })
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
    } catch { /* ignore */ } finally { setLoginHistoryLoading(false) }
  }

  // ── Cache / kill ──────────────────────────────────────────────────────────
  async function purgeLocalCache() {
    try { await clearAllMediaCache() } catch { /* ignore */ }
    try { await purgeLocalMessageCache() } catch { /* ignore */ }
    try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ }
    window.location.reload()
  }

  async function runGlobalKillSwitch() {
    setError(null)
    const expected = t('settings.killPhraseExpected')
    if (killPhrase !== expected) { setError(t('settings.killPhraseMismatch')); return }
    const blob = readVaultBlob(userId)
    if (!blob) { setError(t('settings.noLocalVault')); return }
    try { await unwrapPrivateJwkWithPin(blob, killPin) }
    catch { setError(t('settings.killPinBad')); return }

    // If the server already asked for a TOTP step-up on a prior attempt, demand
    // a well-formed 6-digit code before re-issuing the delete.
    let totpCode: string | undefined
    if (killTotpRequired) {
      totpCode = killTotpCode.replace(/\D/g, '').slice(0, 6)
      if (totpCode.length !== 6) { setError(t('login.totpSixDigits')); return }
    }

    setBusy(true)
    // D7 — actually delete the account server-side (tombstone messages, drop
    // devices/blocks/push, scrub media) BEFORE the local nuclear wipe. Without
    // this the account, public key and discoverability survived a "delete".
    let result
    try {
      result = await deleteMyAccount({ confirm_username: username, totpCode })
    } catch {
      setBusy(false)
      setError(t('settings.killFailed'))
      return
    }

    if (result.ok) {
      // Session cookie is already cleared server-side; sweep all local state.
      void nuclearWipeClient({ revokeServerSessions: true })
      return
    }

    setBusy(false)
    if (result.reason === 'totp_required') {
      setKillTotpRequired(true)
      setError(t('settings.killTotpRequired'))
      return
    }
    if (result.reason === 'totp_invalid') {
      setKillTotpRequired(true)
      setKillTotpCode('')
      setError(t('login.totpInvalid'))
      return
    }
    setError(result.error === 'USERNAME_MISMATCH'
      ? t('settings.killPhraseMismatch')
      : t('settings.killFailed'))
  }

  // ── Export (runs AFTER gate) ───────────────────────────────────────────────
  function execExportVault() {
    const blob = readVaultBlob(userId)
    if (!blob) { setError(t('settings.noLocalVault')); return }
    const payload = JSON.stringify(
      { userId, username, vault: blob, exported_at: new Date().toISOString() },
      null, 2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = 'forest_vault_key.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const settingsReady = discoverable !== null && hidePresence !== null
  const discoverableOn = discoverable === true
  const ghostOn = hidePresence === true
  const settingsBtn = isMd3
    ? 'min-h-11 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--on-surface)_18%,transparent)] px-4 py-2 text-[13px] font-medium tracking-normal transition-colors'
    : isRetro
      ? 'p13-classic-button min-h-11 whitespace-nowrap rounded-none px-3 py-1.5 text-[11px] transition-all duration-150'
      : 'min-h-11 whitespace-nowrap border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out'
  const resolvedTheme = resolveThemeAppearance({
    theme,
    shellMode,
    accentPreset,
    primaryColorOverride,
    accentColorOverride,
    accentSoftColorOverride,
    backgroundColorOverride,
    motionMode,
  })
  const chromeLabel = (label: string) => (isMd3 || isRetro ? label : `[ ${label} ]`)
  const openSettingsTab = (tab: SettingsTabId) => {
    setSettingsTab(tab)
    setMobileSettingsView(tab)
  }

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = modalRef.current
    if (!panel) return
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length > 0) {
      focusable[0]?.focus()
    } else {
      panel.focus()
    }
    return () => {
      openerRef.current?.focus()
    }
  }, [])

  const handleModalKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const panel = modalRef.current
    if (!panel) return
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    )
    if (focusable.length === 0) {
      e.preventDefault()
      panel.focus()
      return
    }
    const current = document.activeElement as HTMLElement | null
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (!current || current === first) {
        e.preventDefault()
        last?.focus()
      }
      return
    }
    if (!current || current === last) {
      e.preventDefault()
      first?.focus()
    }
  }, [onClose])

  return (
    <PortalRoot>
    <div
      className={`p13-settings-root custom-scrollbar fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overflow-x-hidden ${
        isMd3
          ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm'
          : isRetro
            ? 'p13-classic-overlay'
            : 'bg-void/90'
      }`}
      role="dialog" aria-modal="true" aria-label={t('common.settings')}
    >
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
          className={`terminal-panel p13-settings-modal ${isMd3 ? 'md3-settings' : ''} flex h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] w-full min-w-0 max-w-[min(1200px,98vw)] flex-col overflow-hidden sm:h-[calc(100dvh-3rem)] sm:max-h-[calc(100dvh-3rem)] lg:h-[min(92dvh,92vh)] lg:max-h-[min(92dvh,92vh)] ${
        isMd3 ? '!rounded-[28px] !border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] !bg-[var(--surface)]' : isRetro ? '!p13-classic-window !rounded-none !shadow-none' : ''}`}
      >
        {/* ── Header ── */}
        <header className={`flex shrink-0 items-start justify-between gap-2 border-b pb-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : isRetro ? 'p13-classic-titlebar px-3 pt-2' : 'border-neon-red/40'}`}>
          <p className={`min-w-0 break-words text-xs ${isMd3 ? 'text-[var(--on-surface)] tracking-normal' : isRetro ? 'p13-classic-title-copy' : 'uppercase tracking-[0.35em] text-neon-cyan'}`}>
            {t('common.settings')} :: {username}
          </p>
          <button type="button" onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-all duration-200 ease-in-out active:scale-95 ${isMd3 ? 'text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] hover:text-[var(--on-surface)]' : isRetro ? 'p13-classic-button shadow-none' : 'text-neon-red hover:bg-neon-cyan/10 hover:text-neon-cyan'}`}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p13-settings-layout flex min-h-0 flex-1 flex-col overflow-hidden xl:grid xl:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className={`hidden min-h-0 border-r p-2 xl:flex xl:flex-col ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : isRetro ? 'border-border-strong' : 'border-neon-cyan/20'}`}>
            <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSettingsTab(tab.id)}
                  className={`${settingsBtn} w-full text-left hover:scale-[1.01] active:scale-95 ${
                    settingsTab === tab.id
                      ? tab.id === 'security'
                        ? (isMd3 ? 'border-transparent bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-[var(--danger)]' : 'border-neon-red bg-neon-red/10 text-neon-red')
                        : (isMd3 ? 'border-transparent bg-[color-mix(in_srgb,var(--neon-red)_18%,transparent)] text-[var(--on-surface)]' : 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan')
                      : isMd3
                        ? 'bg-transparent text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                        : 'border-border-strong bg-void text-text-muted hover:border-neon-cyan/50'
                  }`}
                >
                  {chromeLabel(t(tab.labelKey as Parameters<typeof t>[0]))}
                </button>
              ))}
            </div>
          </aside>

          <div className="p13-settings-content min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
            <div className={`border-b p-2 xl:hidden ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : isRetro ? 'border-border-strong' : 'border-neon-cyan/20'}`}>
              {mobileSettingsView === 'list' ? (
                <p className={`text-[11px] ${isMd3 ? 'text-[var(--on-surface)]' : isRetro ? 'p13-classic-copy-deep' : 'font-mono uppercase tracking-widest text-neon-cyan'}`}>
                  {t('common.settings')}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => setMobileSettingsView('list')}
                  className={`${settingsBtn} !min-h-9`}
                >
                  {chromeLabel(t('common.back'))}
                </button>
              )}
            </div>

            {mobileSettingsView === 'list' ? (
              <div className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2 xl:hidden">
                {visibleTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => openSettingsTab(tab.id)}
                    className={`${settingsBtn} w-full text-left`}
                  >
                    {chromeLabel(t(tab.labelKey as Parameters<typeof t>[0]))}
                  </button>
                ))}
              </div>
            ) : null}

            <div className={`p13-settings-scroll custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-2 py-4 ${mobileSettingsView === 'list' ? 'hidden xl:block' : 'block'}`}>

          {/* ── VAULT GATE OVERLAY ── */}
          <AnimatePresence>
            {vaultGate && (
              <motion.div
                key="vault-gate"
                initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                className="mb-4"
              >
                <VaultPinGate
                  actionLabel={gateActionLabel(vaultGate)}
                  onVerified={handleVaultGateVerified}
                  onCancel={() => setVaultGate(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* ════════════ SECURITY TAB ════════════ */}
          {settingsTab === 'security' && !vaultGate ? (
            <div className={`space-y-3 ${isMd3 ? 'md3-pane-enter' : ''}`}>

              {/* TOTP — hidden if 2FA is disabled for this instance (Lite self-host) */}
              {capabilities.twofa ? (
              <div className="border border-neon-cyan/30 p-3">
                <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">{t('settings.totpSection')}</p>
                <p className="mb-3 text-[9px] text-danger">{t('settings.totpHint')}</p>
                {user?.totp_enabled === true ? (
                  <div className="space-y-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-neon-cyan">:: {t('settings.totpActive')}</p>
                    {!totpDisableOpen ? (
                      <button type="button" disabled={totpBusy}
                        onClick={() => { setError(null); setVaultGate('totp_disable') }}
                        className="w-full border border-neon-red/70 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40">
                        {chromeLabel(t('settings.totpDisable'))}
                      </button>
                    ) : (
                      <div className="space-y-2 border border-neon-red/40 p-2">
                        <p className="text-[9px] text-danger">{t('settings.totpDisableWarn')}</p>
                        <label className="terminal-label" htmlFor="totp-disable-code">{t('settings.totpDisableCode')}</label>
                        <input id="totp-disable-code" className="terminal-input" inputMode="numeric" maxLength={6}
                          value={totpDisableCode}
                          onChange={(e) => setTotpDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          placeholder="000000"
                        />
                        <div className="flex gap-2">
                          <button type="button" disabled={totpBusy} onClick={() => void disableTotp()}
                            className="flex-1 border border-neon-red bg-void py-1 font-mono text-[10px] uppercase text-neon-red hover:bg-neon-red/10 disabled:opacity-40">
                            {t('common.confirm')}
                          </button>
                          <button type="button" onClick={() => { setTotpDisableOpen(false); setTotpDisableCode('') }}
                            className="flex-1 border border-neon-cyan/40 py-1 font-mono text-[10px] text-neon-cyan">
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-danger">:: {t('settings.totpInactive')}</p>
                    {!totpSetup ? (
                      <button type="button" disabled={totpBusy}
                        onClick={() => { setError(null); setVaultGate('totp_setup') }}
                        className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                        {chromeLabel(t('settings.totpSetup'))}
                      </button>
                    ) : (
                      <div className="space-y-3 border border-neon-cyan/30 p-3">
                        <p className="text-[9px] text-neon-cyan/90">{t('settings.totpScanQr')}</p>
                        <img src={totpSetup.qr_data_url} alt="" className="mx-auto border border-neon-cyan/40 bg-surface p-1" width={192} height={192} />
                        <p className="text-[9px] text-danger">{t('settings.totpSecretManual')}</p>
                        <div className="flex items-start gap-2">
                          <p className="break-all font-mono text-[9px] text-neon-cyan/80 overflow-x-hidden flex-1 select-all">{totpSetup.secret}</p>
                          <button
                            type="button"
                            onClick={() => void navigator.clipboard.writeText(totpSetup.secret)}
                            className="shrink-0 border border-neon-cyan/40 px-2 py-0.5 font-mono text-[8px] uppercase text-neon-cyan/70 hover:bg-neon-cyan/10"
                            title="Copy secret"
                          >
                            COPY
                          </button>
                        </div>
                        <label className="terminal-label" htmlFor="totp-enable-code">{t('settings.totpEnableCode')}</label>
                        <input id="totp-enable-code" className="terminal-input" inputMode="numeric" maxLength={6}
                          value={totpEnableCode}
                          onChange={(e) => setTotpEnableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          placeholder="000000"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button type="button" disabled={totpBusy} onClick={() => void confirmTotpSetup()}
                            className="border border-neon-cyan px-3 py-1 font-mono text-[10px] uppercase text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                            {chromeLabel(t('settings.totpConfirm'))}
                          </button>
                          <button type="button" disabled={totpBusy}
                            onClick={() => { setTotpSetup(null); setTotpEnableCode('') }}
                            className="border border-danger/40 px-3 py-1 font-mono text-[10px] uppercase text-danger hover:text-neon-red">
                            {chromeLabel(t('settings.totpCancelSetup'))}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              ) : null}

              {/* Account Recovery (Option A) */}
              <div className="border border-neon-cyan/30 p-3">
                <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">{t('settings.recoveryTitle')}</p>
                <p className="mb-3 text-[9px] text-text-muted">{t('settings.recoveryHint')}</p>

                {recoveryEnable ? (
                  <div className="space-y-3">
                    <p className="text-[9px] font-semibold text-neon-red">{t('settings.recoverySaveWarning')}</p>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {recoveryEnable.mnemonic.split(' ').map((w, i) => (
                        <div key={i} className="flex items-baseline gap-1 border border-neon-cyan/25 bg-void/60 px-2 py-1">
                          <span className="text-[8px] text-text-muted">{i + 1}</span>
                          <span className="select-all font-mono text-[11px] tracking-wide text-text-primary">{w}</span>
                        </div>
                      ))}
                    </div>
                    {recoveryShowQr && (
                      <div className="flex justify-center border border-neon-cyan/25 bg-void p-3">
                        <QRCodeSVG value={recoveryEnable.mnemonic} size={180} bgColor="#000000" fgColor="#22d3ee" level="M" className="max-w-full" />
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => downloadRecoveryPhrase(recoveryEnable.mnemonic)}
                        className="flex-1 border border-neon-cyan bg-void py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
                        {chromeLabel(t('settings.recoveryDownload'))}
                      </button>
                      <button type="button" onClick={() => { void navigator.clipboard.writeText(recoveryEnable.mnemonic) }}
                        className="border border-neon-cyan/50 bg-void px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
                        COPY
                      </button>
                      <button type="button" onClick={() => setRecoveryShowQr((v) => !v)}
                        className="border border-neon-cyan/50 bg-void px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
                        {chromeLabel(t('settings.recoveryShowQr'))}
                      </button>
                    </div>
                    {user?.totp_enabled === true && (
                      <label className="flex items-center gap-2 text-[9px] text-text-muted">
                        <input type="checkbox" checked={recoveryRequireTotp} onChange={(e) => setRecoveryRequireTotp(e.target.checked)} />
                        {t('settings.recoveryRequireTotp')}
                      </label>
                    )}
                    <label className="flex items-center gap-2 text-[9px] text-text-muted">
                      <input type="checkbox" checked={recoverySavedConfirmed} onChange={(e) => setRecoverySavedConfirmed(e.target.checked)} />
                      {t('settings.recoverySavedConfirm')}
                    </label>
                    <div className="flex gap-2">
                      <button type="button" disabled={!recoverySavedConfirmed || recoveryBusy} onClick={() => void confirmRecoveryEnable()}
                        className="flex-1 border border-neon-cyan bg-void py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                        {recoveryBusy ? (isMd3 ? '…' : '[ ... ]') : chromeLabel(t('settings.recoveryEnableConfirm'))}
                      </button>
                      <button type="button" onClick={cancelRecoveryEnable}
                        className="flex-1 border border-border-strong/60 py-1.5 font-mono text-[10px] text-text-muted">
                        {chromeLabel(t('common.cancel'))}
                      </button>
                    </div>
                  </div>
                ) : recoveryStatus?.enabled ? (
                  <div className="space-y-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-neon-cyan">
                      :: {t('settings.recoveryEnabledState')}{recoveryStatus.require_totp ? ` · ${t('settings.recoveryTotpOn')}` : ''}
                    </p>
                    <div className="flex gap-2">
                      <button type="button" disabled={recoveryBusy}
                        onClick={() => { setError(null); setVaultGate('recovery_enable') }}
                        className="flex-1 border border-neon-cyan/60 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                        {recoveryBusy ? (isMd3 ? '…' : '[ ... ]') : chromeLabel(t('settings.recoveryReissue'))}
                      </button>
                      <button type="button" disabled={recoveryBusy}
                        onClick={() => { setError(null); setVaultGate('recovery_disable') }}
                        className="flex-1 border border-neon-red/70 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red hover:bg-neon-red/10 disabled:opacity-40">
                        {chromeLabel(t('settings.recoveryDisable'))}
                      </button>
                    </div>
                    <p className="text-[8px] text-text-muted">{t('settings.recoveryReissueHint')}</p>
                  </div>
                ) : (
                  <button type="button" disabled={recoveryBusy}
                    onClick={() => { setError(null); setVaultGate('recovery_enable') }}
                    className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                    {chromeLabel(t('settings.recoveryEnable'))}
                  </button>
                )}
                {recoverySuccess && <p className="mt-2 text-[10px] text-neon-cyan">:: {t('settings.recoverySuccess')}</p>}
              </div>

              {/* Change Vault PIN */}
              <div className="border border-neon-cyan/30 p-3">
                <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">{t('settings.changePinTitle')}</p>
                <p className="mb-3 text-[9px] text-danger">{t('settings.changePinHint')}</p>
                {!changePinOpen ? (
                  <button type="button"
                    onClick={() => { setChangePinOpen(true); setChangePinOld(''); setChangePinNew(''); setChangePinConfirm(''); setError(null) }}
                    className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
                    {chromeLabel(t('settings.changePinAction'))}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <label className="terminal-label" htmlFor="change-pin-old">{t('settings.changePinOld')}</label>
                    <input id="change-pin-old" type="password" className="terminal-input text-[10px]" value={changePinOld} onChange={(e) => setChangePinOld(e.target.value)} autoComplete="off" />
                    <label className="terminal-label" htmlFor="change-pin-new">{t('settings.changePinNew')}</label>
                    <input id="change-pin-new" type="password" className="terminal-input text-[10px]" value={changePinNew} onChange={(e) => setChangePinNew(e.target.value)} autoComplete="off" />
                    <label className="terminal-label" htmlFor="change-pin-confirm">{t('settings.changePinConfirmLabel')}</label>
                    <input id="change-pin-confirm" type="password" className="terminal-input text-[10px]" value={changePinConfirm} onChange={(e) => setChangePinConfirm(e.target.value)} autoComplete="off" />
                    <div className="flex gap-2">
                      <button type="button" disabled={changePinBusy} onClick={() => void changeVaultPin()}
                        className="flex-1 border border-neon-cyan bg-void py-1 font-mono text-[10px] uppercase text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                        {changePinBusy ? (isMd3 ? '…' : '[ ... ]') : chromeLabel(t('common.confirm'))}
                      </button>
                      <button type="button"
                        onClick={() => { setChangePinOpen(false); setChangePinOld(''); setChangePinNew(''); setChangePinConfirm('') }}
                        className="flex-1 border border-border-strong/60 py-1 font-mono text-[10px] text-text-muted">
                        {chromeLabel(t('common.cancel'))}
                      </button>
                    </div>
                  </div>
                )}
                {changePinSuccess && <p className="mt-2 text-[10px] text-neon-cyan">:: {t('settings.changePinSuccess')}</p>}
              </div>

              {/* Export Vault Key — GATED */}
              <div className="border border-neon-cyan/30 p-3">
                <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">{t('settings.exportVaultTitle')}</p>
                <p className="mb-3 text-[9px] text-danger">{t('settings.exportVaultHint')}</p>
                <button type="button"
                  onClick={() => { setError(null); setVaultGate('export') }}
                  className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10">
                  {chromeLabel(t('settings.exportVaultAction'))}
                </button>
              </div>

              {/* Auto-lock */}
              <div className="flex flex-col gap-2 border border-neon-cyan/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.autoLockTitle')}</p>
                  <p className="break-words text-[9px] text-danger">{t('settings.autoLockHint')}</p>
                </div>
                <select
                  className="terminal-input h-8 w-full max-w-[10rem] shrink-0 py-1 text-xs uppercase"
                  value={autoLockTimeout}
                  onChange={(e) => { const val = Number(e.target.value) as AutoLockTimeout; setAutoLockTimeoutState(val); saveAutoLockTimeout(val) }}
                  aria-label={t('settings.autoLockTitle')}
                >
                  {AUTO_LOCK_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{t(opt.labelKey as Parameters<typeof t>[0])}</option>
                  ))}
                </select>
              </div>

              {/* Device Linking — ON requires vault gate */}
              <div className="flex flex-col gap-2 border border-neon-cyan/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('common.deviceLinking')}</p>
                  <p className="break-words text-[9px] text-danger">{allowNewDeviceLinking ? 'ON' : 'OFF'}</p>
                </div>
                <button type="button"
                  onClick={() => {
                    if (!allowNewDeviceLinking) {
                      // Включение — нужен vault-пароль
                      setError(null)
                      setVaultGate('device_linking_on')
                    } else {
                      // Выключение — безопасно, без пароля
                      void setDeviceLinking(false)
                    }
                  }}
                  className={`shrink-0 border px-3 py-2 font-mono text-[10px] uppercase tracking-widest ${
                    allowNewDeviceLinking
                      ? 'border-neon-cyan bg-neon-cyan/20 text-neon-cyan'
                      : 'border-neon-red bg-neon-red/10 text-neon-red'
                  }`}>
                  [{allowNewDeviceLinking ? 'ON' : 'OFF'}]
                </button>
              </div>

              {/* Read Receipts */}
              <div className="border border-neon-cyan/30 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('privacy.readReceipts')}</p>
                    <p className="break-words text-[9px] text-danger">{t('privacy.readReceiptsHint')}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={disableReadReceipts === true}
                    disabled={busy || disableReadReceipts === null}
                    onClick={() => void toggleReadReceipts()}
                    className={`shrink-0 border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                      disableReadReceipts === null ? 'border-border-strong bg-void text-text-muted/70'
                      : disableReadReceipts ? 'border-neon-red bg-neon-red/10 text-neon-red shadow-[0_0_14px_rgba(239,68,68,0.25)]'
                      : 'border-border-strong/60 bg-void text-text-muted'
                    } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}>
                    {busy ? (isMd3 ? '…' : '[ … ]') : disableReadReceipts === null ? (isMd3 ? '—' : '[ -- ]') : disableReadReceipts ? (isMd3 ? 'OFF' : '[ OFF ]') : (isMd3 ? 'ON' : '[ ON ]')}
                  </button>
                </div>
              </div>

              {/* Blocked Users */}
              <div className="border border-neon-cyan/30 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('block.title')}</p>
                    <p className="text-[9px] text-danger">{t('block.hint')}</p>
                  </div>
                  <button type="button" onClick={() => void loadBlockedUsers()} disabled={blockedLoading}
                    className="shrink-0 border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10 disabled:opacity-40">
                    {blockedLoading ? (isMd3 ? '…' : '[ ... ]') : chromeLabel('LOAD')}
                  </button>
                </div>
                {blockedUsers.length === 0 ? (
                  <p className="text-[9px] text-text-muted/70">{t('block.empty')}</p>
                ) : (
                  <div className="custom-scrollbar space-y-1 max-h-40 overflow-y-auto">
                    {blockedUsers.map((u) => (
                      <div key={u.user_id} className="flex items-center justify-between border border-border-strong px-2 py-1">
                        <span className="font-mono text-[10px] text-neon-cyan/80 truncate">@{u.username}</span>
                        <button type="button" onClick={() => void unblockUser(u.user_id)}
                          className="shrink-0 border border-neon-red/50 px-2 py-0.5 font-mono text-[8px] uppercase text-neon-red hover:bg-neon-red/10">
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
                    <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('security.loginHistory')}</p>
                    <p className="text-[9px] text-danger">{t('security.loginHistoryHint')}</p>
                  </div>
                  <button type="button" onClick={() => void loadLoginHistory()} disabled={loginHistoryLoading}
                    className="shrink-0 border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10 disabled:opacity-40">
                    {loginHistoryLoading ? (isMd3 ? '…' : '[ ... ]') : chromeLabel('LOAD')}
                  </button>
                </div>
                {loginHistory.length === 0 ? (
                  <p className="text-[9px] text-text-muted/70">{t('security.loginNoEvents')}</p>
                ) : (
                  <div className="custom-scrollbar space-y-1 max-h-48 overflow-y-auto">
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
                        <div key={ev.id} className="border border-border-strong px-2 py-1">
                          <div className="flex items-center justify-between">
                            <span className={`font-mono text-[9px] uppercase tracking-wider ${isSuccess ? 'text-neon-cyan' : 'text-neon-red'}`}>{outcomeLabel}</span>
                            <span className="font-mono text-[8px] text-text-muted">{new Date(ev.created_at).toLocaleString()}</span>
                          </div>
                          <p className="font-mono text-[8px] text-text-muted/70 truncate">
                            {ev.ip_address ?? '—'} · {ev.user_agent?.slice(0, 60) ?? '—'}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Trust Registry */}
              <div className={isMd3 ? 'rounded-2xl bg-[var(--surface-variant)] p-4 space-y-2' : 'border border-neon-cyan/30 p-3 space-y-2'}>
                <p className={isMd3 ? 'text-sm font-medium text-[var(--on-surface)]' : 'text-xs uppercase tracking-widest text-neon-cyan'}>
                  {t('settings.trustRegistry')}
                </p>
                <p className={isMd3 ? 'text-xs text-[var(--on-surface-variant)]' : 'text-[9px] text-text-muted/70'}>
                  {t('settings.trustRegistryHint')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const count = getTrustedPeerCount()
                    alert(count === 0 ? 'No verified contacts yet.' : `${count} verified contact(s) on this device.`)
                  }}
                  className={isMd3
                    ? 'rounded-full bg-[var(--secondary-container)] text-[var(--on-secondary-container)] px-4 py-2 text-xs font-medium hover:opacity-90'
                    : 'border border-neon-cyan/40 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10'}
                >
                  {t('settings.trustRegistryCount')}
                </button>
              </div>

              {/* Kill Switch */}
              <div className="border-t border-danger/40 pt-3">
                <button type="button" onClick={() => setKillOpen((v) => !v)}
                  className="glitch-text mb-2 w-full border border-danger/40 bg-void py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-danger/80 hover:bg-danger/30">
                  {t('settings.killExecute')}
                </button>
                <AnimatePresence initial={false}>
                  {killOpen && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                      <p className="mb-2 break-words text-[9px] text-danger">{t('settings.killSwitchHint')}</p>
                      <label className="terminal-label" htmlFor="kill-phrase">{t('settings.killPhraseLabel')}</label>
                      <input id="kill-phrase" className="terminal-input mb-2 text-[10px]" value={killPhrase}
                        onChange={(e) => setKillPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
                      <label className="terminal-label" htmlFor="kill-pin">{t('settings.killPinLabel')}</label>
                      <input id="kill-pin" type="password" className="terminal-input mb-2 text-[10px]" value={killPin}
                        onChange={(e) => setKillPin(e.target.value)} autoComplete="off" />
                      {killTotpRequired ? (
                        <>
                          <label className="terminal-label" htmlFor="kill-totp">{t('settings.killTotpLabel')}</label>
                          <input id="kill-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                            className="terminal-input mb-2 text-[10px]" value={killTotpCode}
                            onChange={(e) => setKillTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                        </>
                      ) : null}
                      <TerminalGlitchButton type="button" disabled={busy} onClick={() => void runGlobalKillSwitch()}
                        className="w-full !border-danger/40 !py-2 !text-[10px] !text-danger/80 hover:!bg-danger/30">
                        {chromeLabel(t('settings.killExecute'))}
                      </TerminalGlitchButton>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

            </div>
          ) : null}

          {/* ════════════ MEDIA / DEVICES / STICKERS TABS ════════════ */}
          {settingsTab === 'media' ? <SettingsMediaPanel active /> : null}
          {settingsTab === 'devices' ? <SettingsDevicesPanel userId={userId} active /> : null}
          {settingsTab === 'folders' ? <SettingsChatFoldersPanel userId={userId} /> : null}
          {settingsTab === 'stickers' && capabilities.stickers ? <SettingsStickersPanel /> : null}

          {/* ════════════ PROFILE TAB ════════════ */}
          {settingsTab === 'profile' ? (
            <div className={`space-y-4 ${isMd3 ? 'md3-pane-enter' : ''}`}>
              <SettingsAvatarSection userId={userId} username={username} />
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <label className="terminal-label" htmlFor="profile-display-name">{t('profile.editName')}</label>
                <input id="profile-display-name" className="terminal-input text-[10px]" maxLength={64}
                  value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} />
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-1">
                <p className="terminal-label">@{t('common.peerInputAria')}</p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-neon-cyan/70">@{username}</span>
                  <span className="font-mono text-[8px] uppercase tracking-widest text-text-muted/70">({t('profile.readOnly')})</span>
                </div>
                <p className="terminal-label pt-2">{t('sidebar.copyMyInvite')}</p>
                <p className="text-[9px] text-text-muted/80">{t('profile.myLinkHint')}</p>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-neon-cyan/70">{myInviteLink}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!myInviteLink) return
                      void navigator.clipboard.writeText(myInviteLink)
                        .then(() => { setMyLinkCopied(true); setTimeout(() => setMyLinkCopied(false), 1500) })
                        .catch(() => {})
                    }}
                    className="shrink-0 border border-neon-cyan/40 bg-void px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/80 hover:bg-neon-cyan/10"
                  >
                    {myLinkCopied ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <label className="terminal-label" htmlFor="profile-channel-select">{t('profile.myChannel')}</label>
                <p className="text-[9px] text-text-muted/80">{t('profile.myChannelHint')}</p>
                <select
                  id="profile-channel-select"
                  className="terminal-input w-full text-[10px]"
                  value={profileChannelId}
                  disabled={channelSaveBusy}
                  onChange={(e) => { void saveProfileChannel(e.target.value) }}
                >
                  <option value="">{t('profile.myChannelNone')}</option>
                  {myChannels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name || c.id.slice(0, 8)}</option>
                  ))}
                </select>
                {myChannels.length === 0 ? (
                  <p className="text-[9px] text-text-muted/70">{t('profile.myChannelEmpty')}</p>
                ) : null}
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <label className="terminal-label" htmlFor="profile-bio-tab">{t('profile.bio')}</label>
                <textarea id="profile-bio-tab" className="terminal-input mt-1 min-h-[5rem] w-full resize-y text-[10px]"
                  maxLength={256} value={bio} onChange={(e) => setBio(e.target.value)} placeholder={t('profile.bioPlaceholder')} />
                <p className={`text-right font-mono text-[8px] ${bio.length > 230 ? 'text-neon-red' : 'text-text-muted/70'}`}>{bio.length}/256</p>
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <label className="terminal-label" htmlFor="profile-status-tab">{t('profile.statusText')}</label>
                <input id="profile-status-tab" className="terminal-input text-[10px]" maxLength={128}
                  value={statusText} onChange={(e) => setStatusText(e.target.value)} placeholder={t('profile.statusPlaceholder')} />
                <div className="flex flex-wrap gap-1 mt-1">
                  <p className="w-full text-[8px] uppercase tracking-widest text-text-muted/70">{t('profile.statusPresets')}:</p>
                  {[
                    { label: t('profile.online'), value: '' },
                    { label: t('profile.busy'), value: 'busy' },
                    { label: t('profile.doNotDisturb'), value: 'do not disturb' },
                    { label: 'DEAD_INSIDE', value: 'dead_inside' },
                  ].map((preset) => (
                    <button key={preset.value} type="button" onClick={() => setStatusText(preset.value)}
                      className={`border px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest transition-colors ${
                        statusText === preset.value ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan' : 'border-border-strong text-text-muted hover:border-neon-cyan/50'
                      }`}>{preset.label}</button>
                  ))}
                </div>
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <p className="terminal-label">{t('profile.lastSeenSettings')}</p>
                <p className="text-[9px] text-danger">{t('profile.lastSeenPrivacyHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {(['everyone', 'contacts', 'nobody'] as const).map((opt) => (
                    <button key={opt} type="button" onClick={() => setLastSeenPrivacy(opt)}
                      className={`border px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors ${
                        lastSeenPrivacy === opt ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan' : 'border-border-strong text-text-muted hover:border-neon-cyan/50'
                      }`}>{t(`profile.lastSeen${opt.charAt(0).toUpperCase() + opt.slice(1)}` as Parameters<typeof t>[0])}</button>
                  ))}
                </div>
              </div>
              <div className="border border-neon-cyan/30 p-3 space-y-2">
                <p className="terminal-label">{t('profile.socialLinks')}</p>
                <div className="space-y-2">
                  {socialLinks.map((link, idx) => (
                    <div key={idx} className="flex gap-2">
                      <select className="terminal-input w-28 text-[10px]" value={link.platform}
                        onChange={(e) => { const next = [...socialLinks]; next[idx] = { ...next[idx], platform: e.target.value }; setSocialLinks(next) }}>
                        <option value="telegram">Telegram</option>
                        <option value="github">GitHub</option>
                        <option value="website">Website</option>
                      </select>
                      <input className="terminal-input flex-1 text-[10px]" value={link.url}
                        onChange={(e) => { const next = [...socialLinks]; next[idx] = { ...next[idx], url: e.target.value }; setSocialLinks(next) }}
                        placeholder={t('profile.url')} />
                      <button type="button" onClick={() => setSocialLinks(socialLinks.filter((_, i) => i !== idx))}
                        aria-label={t('common.close')} title={t('common.close')}
                        className="flex shrink-0 items-center justify-center border border-neon-red/50 px-2 py-1 text-neon-red hover:bg-neon-red/10">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {socialLinks.length < 5 && (
                    <button type="button" onClick={() => setSocialLinks([...socialLinks, { platform: 'telegram', url: '' }])}
                      className="w-full border border-neon-cyan/40 bg-void py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10">
                      + {t('profile.addLink')}
                    </button>
                  )}
                </div>
              </div>
              <button type="button" disabled={profileBusy}
                onClick={() => {
                  setProfileBusy(true); setError(null)
                  void patchMyProfile({ bio, status_text: statusText, display_name: displayName.trim(), last_seen_privacy: lastSeenPrivacy, social_links: socialLinks.filter((l) => l.url.trim()) })
                    .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500) })
                    .catch((e) => { setError(explainSettingsError(e instanceof Error ? e.message : '', t, 'profile.saveFailed')) })
                    .finally(() => setProfileBusy(false))
                }}
                className="w-full border border-neon-cyan bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40">
                {profileBusy ? (isMd3 ? '…' : '[ ... ]') : chromeLabel(t('profile.saveProfile'))}
              </button>
              <div className="border-t border-neon-red/40 pt-3 space-y-3">
                <p className="text-xs uppercase tracking-widest text-neon-red">{t('profile.dangerZone')}</p>
                <button type="button" onClick={() => openSettingsTab('security')}
                  className="w-full border border-neon-red/50 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red/70 hover:bg-neon-red/10 hover:text-neon-red transition-colors">
                  {chromeLabel(t('profile.changePassword'))}
                </button>
                <button type="button" onClick={() => { setKillOpen(true); openSettingsTab('security') }}
                  className="w-full border border-danger/40 bg-void py-2 font-mono text-[10px] uppercase tracking-widest text-danger/80 hover:bg-danger/30 transition-colors">
                  {chromeLabel(t('profile.deleteAccount'))}
                </button>
              </div>
            </div>
          ) : null}

          {/* ════════════ MAIN TAB ════════════ */}
          <div className={`space-y-3 ${(settingsTab !== 'main' && settingsTab !== 'chat') ? 'hidden' : ''} ${isMd3 ? 'md3-pane-enter' : ''}`}>
            {settingsTab === 'chat' ? (
              <>
                {capabilities.push ? <SettingsPushNotifications userId={userId} /> : null}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.chatSoundTitle')}</p>
                    <p className="break-words text-[9px] text-danger">{t('settings.chatSoundHint')}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={chatSoundEnabled}
                    onClick={() => setChatSoundEnabled(!chatSoundEnabled)}
                    className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                      chatSoundEnabled ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]' : 'border-border-strong/60 bg-void text-text-muted'
                    } hover:border-neon-red hover:text-neon-red`}>
                    {chatSoundEnabled ? (isMd3 ? 'ON' : '[ ON ]') : (isMd3 ? 'OFF' : '[ OFF ]')}
                  </button>
                </div>
                <div className="space-y-2 border-t border-neon-cyan/20 pt-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.appearanceTitle')}</p>
                      <p className="mt-1 text-[9px] text-danger">{t('settings.appearanceHint')}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => resetAppearance()}
                      className="shrink-0 border border-neon-cyan/30 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:bg-neon-cyan/10"
                    >
                      {t('settings.appearanceReset')}
                    </button>
                  </div>
                  <div className="flex flex-col gap-2 border border-neon-cyan/20 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.soundSchemeTitle')}</p>
                      <p className="break-words text-[9px] text-danger">{t('settings.soundSchemeHint')}</p>
                    </div>
                    <select
                      className="terminal-input h-9 w-full max-w-[12rem] py-1 text-xs"
                      value={chatSoundScheme}
                      onChange={(e) => setChatSoundScheme(e.target.value as ChatSoundSchemeId)}
                      aria-label={t('settings.soundSchemeTitle')}
                    >
                      {CHAT_SOUND_SCHEMES.map((scheme) => (
                        <option key={scheme.id} value={scheme.id}>{scheme.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className={`rounded-[var(--radius-md)] border p-3 ${isRetro ? 'p13-classic-strip' : 'border-neon-cyan/20 bg-void/30'}`}>
                    <p className={`mb-2 text-[9px] uppercase tracking-[0.28em] ${isRetro ? 'p13-classic-copy-soft' : 'text-neon-cyan/70'}`}>
                      {t('settings.appearanceShellTitle')}
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                      {appearanceStyles.map((sp) => (
                        <button
                          key={sp.id}
                          type="button"
                          onClick={() => {
                            if (sp.id === 'retro') {
                              setShellMode('terminal')
                              setTheme('retro')
                              return
                            }
                            if (sp.id === 'md3') {
                              setShellMode('md3')
                              if (theme === 'retro') setTheme('md3dark')
                              return
                            }
                            setShellMode('terminal')
                            if (theme === 'retro' || theme === 'md3dark' || theme === 'md3light') {
                              setTheme('default')
                            }
                          }}
                          className={`flex items-start gap-3 border px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest transition-all duration-150 ${
                            appearanceStyle === sp.id
                              ? (isMd3 ? 'border-transparent bg-[color-mix(in_srgb,var(--neon-red)_16%,transparent)] text-[var(--on-surface)] shadow-[var(--md3-elevation-1)]' : 'border-neon-cyan text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.2)]')
                              : (isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_14%,transparent)] text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]' : 'border-neon-red/25 text-neon-red/50 hover:border-neon-red/60 hover:text-neon-red')
                          }`}
                        >
                          <span className="flex flex-col">
                            <span>{sp.label}</span>
                            <span className="text-[8px] text-text-muted">{sp.hint}</span>
                          </span>
                          {appearanceStyle === sp.id && <span className={`ml-auto ${isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan'}`}>◆</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={`rounded-[var(--radius-md)] border p-3 ${isRetro ? 'p13-classic-strip' : 'border-neon-cyan/20 bg-void/30'}`}>
                    <div className="mb-2">
                      <p className={`text-[9px] uppercase tracking-[0.28em] ${isRetro ? 'p13-classic-copy-soft' : 'text-neon-cyan/70'}`}>
                        {t('settings.appearancePlatformTitle')}
                      </p>
                      <p className="mt-1 text-[9px] text-text-muted">
                        {t('settings.appearancePlatformHint')}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {platformProfiles.map((profile) => (
                        <button
                          key={profile.id}
                          type="button"
                          onClick={() => setPlatformProfile(profile.id)}
                          className={`flex items-start gap-3 border px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest transition-all duration-150 ${
                            platformProfile === profile.id
                              ? (isMd3
                                ? 'border-transparent bg-[color-mix(in_srgb,var(--neon-red)_16%,transparent)] text-[var(--on-surface)] shadow-[var(--md3-elevation-1)]'
                                : 'border-neon-cyan text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.2)]')
                              : (isMd3
                                ? 'border-[color-mix(in_srgb,var(--on-surface)_14%,transparent)] text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                                : 'border-neon-red/25 text-neon-red/50 hover:border-neon-red/60 hover:text-neon-red')
                          }`}
                        >
                          <span className="flex flex-col">
                            <span>{profile.label}</span>
                            <span className="text-[8px] text-text-muted">{profile.hint}</span>
                          </span>
                          {platformProfile === profile.id ? (
                            <span className={`ml-auto ${isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan'}`}>◆</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>

                  <p className="mt-1 text-[9px] uppercase tracking-[0.28em] text-neon-cyan/70">
                    {t('settings.appearancePaletteTitle')}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                    {palettesForStyle.map((t_cfg) => (
                      <button key={t_cfg.id} type="button" onClick={() => setTheme(t_cfg.id as ThemeId)}
                        className={`flex items-center gap-3 border px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest transition-all duration-150 ${
                          theme === t_cfg.id
                            ? (isMd3 ? 'border-transparent bg-[color-mix(in_srgb,var(--neon-red)_16%,transparent)] text-[var(--on-surface)] shadow-[var(--md3-elevation-1)]' : 'border-neon-cyan text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.2)]')
                            : (isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_14%,transparent)] text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]' : 'border-neon-red/25 text-neon-red/50 hover:border-neon-red/60 hover:text-neon-red')
                        }`}>
                        <span className="flex shrink-0 gap-0.5">
                          <span className="h-3 w-3 border border-border-strong/10" style={{ background: t_cfg.preview[0] }} />
                          <span className="h-3 w-3 border border-border-strong/10" style={{ background: t_cfg.preview[1] }} />
                          <span className="h-3 w-3 border border-border-strong/10" style={{ background: t_cfg.preview[2] }} />
                          <span className="h-3 w-3 border border-border-strong/10" style={{ background: t_cfg.preview[3] }} />
                        </span>
                        {t_cfg.label}
                        {theme === t_cfg.id && <span className={`ml-auto ${isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan'}`}>◆</span>}
                      </button>
                    ))}
                  </div>

                  <div className="rounded-[var(--radius-md)] border border-neon-cyan/20 bg-void/30 p-3">
                    <div className="flex flex-wrap gap-2">
                      {ACCENT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setAccentPreset(preset.id)}
                          className={`flex items-center gap-2 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors ${
                            accentPreset === preset.id
                              ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10'
                              : 'border-border-strong text-text-muted hover:border-neon-cyan/50 hover:text-neon-cyan'
                          }`}
                        >
                          {preset.id !== 'theme' ? (
                            <span className="flex gap-1">
                              <span className="h-2.5 w-2.5 border border-border-strong/10" style={{ background: preset.primary }} />
                              <span className="h-2.5 w-2.5 border border-border-strong/10" style={{ background: preset.accent }} />
                            </span>
                          ) : (
                            <span className="h-2.5 w-2.5 border border-border-strong/10 bg-transparent" />
                          )}
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-4">
                      {[
                        {
                          key: 'primary',
                          label: t('settings.appearancePrimary'),
                          value: primaryColorOverride ?? resolvedTheme.tokens.primary,
                          onChange: setPrimaryColorOverride,
                        },
                        {
                          key: 'accent',
                          label: t('settings.appearanceAccent'),
                          value: accentColorOverride ?? resolvedTheme.tokens.accent,
                          onChange: setAccentColorOverride,
                        },
                        {
                          key: 'accentSoft',
                          label: t('settings.appearanceAccent2'),
                          value: accentSoftColorOverride ?? resolvedTheme.tokens.accentSoft,
                          onChange: setAccentSoftColorOverride,
                        },
                        {
                          key: 'background',
                          label: t('settings.appearanceBackground'),
                          value: backgroundColorOverride ?? resolvedTheme.tokens.background,
                          onChange: setBackgroundColorOverride,
                        },
                      ].map((item) => (
                        <label key={item.key} className="space-y-1">
                          <span className="terminal-label">{item.label}</span>
                          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-neon-cyan/20 bg-void/40 px-2 py-2">
                            <input
                              type="color"
                              value={item.value}
                              onChange={(e) => item.onChange(e.target.value)}
                              className="h-8 w-10 cursor-pointer border border-neon-cyan/30 bg-transparent"
                            />
                            <input
                              type="text"
                              value={item.value}
                              onChange={(e) => item.onChange(e.target.value)}
                              className="terminal-input h-8 px-2 py-1 text-[10px]"
                              spellCheck={false}
                            />
                          </div>
                        </label>
                      ))}
                    </div>

                    <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-neon-cyan">{t('settings.appearanceMotion')}</p>
                        <p className="text-[9px] text-text-muted">{t('settings.appearanceMotionHint')}</p>
                      </div>
                      <div className="flex gap-2">
                        {([
                          ['full', t('settings.appearanceMotionFull')],
                          ['reduced', t('settings.appearanceMotionReduced')],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setMotionMode(mode as MotionMode)}
                            className={`border px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest ${
                              motionMode === mode
                                ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                                : 'border-border-strong text-text-muted hover:border-neon-cyan/40 hover:text-neon-cyan'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div
                      className="mt-3 overflow-hidden border p-3"
                      style={{
                        borderColor: resolvedTheme.tokens.border,
                        borderRadius: resolvedTheme.tokens.panelRadius,
                        background: `linear-gradient(135deg, ${resolvedTheme.tokens.surface} 0%, ${resolvedTheme.tokens.elevated} 100%)`,
                        boxShadow: `0 0 24px rgba(${resolvedTheme.tokens.shadowRgb}, 0.14)`,
                        fontFamily: resolvedTheme.tokens.fontFamily,
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <span className="h-10 w-10 border border-border-strong/10" style={{ background: resolvedTheme.tokens.primary }} />
                        <div className="min-w-0">
                          <p className="truncate text-[11px] uppercase tracking-widest" style={{ color: resolvedTheme.tokens.text }}>
                            {resolvedTheme.label}
                          </p>
                          <p className="text-[10px]" style={{ color: resolvedTheme.tokens.muted }}>
                            {t('settings.appearancePreviewHint')}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="flex-1 px-3 py-2 text-[10px] font-semibold" style={{ background: resolvedTheme.tokens.primary, color: resolvedTheme.tokens.background }}>
                          PRIMARY
                        </div>
                        <div className="flex-1 border px-3 py-2 text-[10px] font-semibold" style={{ borderColor: resolvedTheme.tokens.border, color: resolvedTheme.tokens.accent }}>
                          ACCENT
                        </div>
                        <div className="flex-1 border px-3 py-2 text-[10px] font-semibold" style={{ borderColor: resolvedTheme.tokens.border, color: resolvedTheme.tokens.accentSoft }}>
                          ACCENT 2
                        </div>
                        <div className="flex-1 border px-3 py-2 text-[10px] font-semibold" style={{ borderColor: resolvedTheme.tokens.border, color: resolvedTheme.tokens.text, background: resolvedTheme.tokens.background }}>
                          BACKGROUND
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {settingsTab === 'main' ? (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.discoverable')}</p>
                <p className="break-words text-[9px] text-danger">{t('settings.discoverableHint')}</p>
                <p className={`mt-1 font-mono text-[9px] uppercase tracking-wider ${
                  !settingsReady ? 'text-text-muted/70' : discoverableOn ? 'text-neon-cyan' : 'text-text-muted'
                }`}>
                  {!settingsReady ? ':: …' : discoverableOn ? t('settings.discoverableBadgeOn') : t('settings.discoverableBadgeOff')}
                </p>
              </div>
              <button type="button" role="switch" aria-label={t('settings.discoverable')} aria-checked={discoverableOn}
                disabled={busy || !settingsReady} onClick={() => void toggleDiscoverable()}
                className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                  !settingsReady ? 'border-border-strong bg-void text-text-muted/70'
                  : discoverableOn ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                  : 'border-border-strong/60 bg-void text-text-muted'
                } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}>
                {busy ? (isMd3 ? '…' : '[ … ]') : !settingsReady ? (isMd3 ? '—' : '[ -- ]') : discoverableOn ? (isMd3 ? 'ON' : '[ ON ]') : (isMd3 ? 'OFF' : '[ OFF ]')}
              </button>
            </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('settings.ghostPresence')}</p>
                <p className="break-words text-[9px] text-danger">{t('settings.ghostPresenceHint')}</p>
              </div>
              <button type="button" role="switch" aria-checked={ghostOn}
                disabled={busy || !settingsReady} onClick={() => void toggleHidePresence()}
                className={`shrink-0 self-start border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-all duration-200 ease-in-out hover:scale-[1.02] active:scale-95 ${
                  !settingsReady ? 'border-border-strong bg-void text-text-muted/70'
                  : ghostOn ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                  : 'border-border-strong/60 bg-void text-text-muted'
                } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}>
                {busy ? (isMd3 ? '…' : '[ … ]') : !settingsReady ? (isMd3 ? '—' : '[ -- ]') : ghostOn ? (isMd3 ? 'ON' : '[ ON ]') : (isMd3 ? 'OFF' : '[ OFF ]')}
              </button>
            </div>
            <div className="flex flex-col gap-2 border-t border-neon-cyan/30 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('common.language')} / Язык</p>
                <p className="break-words text-[9px] text-danger">{t('settings.languageHint')}</p>
              </div>
              <select className="terminal-input h-8 w-full max-w-[10rem] shrink-0 py-1 text-xs uppercase"
                value={locale} onChange={(e) => setLocale(e.target.value === 'ru' ? 'ru' : 'en')}
                aria-label={`${t('common.language')} / Язык`}>
                <option value="en">EN</option>
                <option value="ru">RU</option>
              </select>
            </div>
            <div className="border-t border-neon-red/40 pt-3">
              <p className="mb-1 text-xs uppercase tracking-widest text-neon-red">{t('settings.dangerZone')}</p>
              <p className="mb-2 break-words text-[9px] text-text-muted">{t('settings.purgeHint')}</p>
              <TerminalGlitchButton type="button" onClick={() => void purgeLocalCache()}
                className="w-full !border-neon-red !px-2 !py-2 !text-[10px] !text-neon-red hover:!bg-neon-red/10">
                {chromeLabel(t('settings.purgeLocalCache'))}
              </TerminalGlitchButton>
            </div>
              </>
            ) : null}
          </div>

            </div>{/* end scroll area */}
          </div>
        </div>

        {error && (
          <p className="shrink-0 border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red break-words overflow-x-hidden">[!] {error}</p>
        )}
        {saved && (
          <p className="shrink-0 text-[10px] text-neon-cyan">:: {t('common.saved')}</p>
        )}
        <div className="mt-2 shrink-0 border-t border-danger/40 px-0.5 pt-3">
          <LogoutButton variant="critical" />
        </div>
      </motion.div>
    </div>
    </PortalRoot>
  )
}

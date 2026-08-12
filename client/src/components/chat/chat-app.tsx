'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { Menu, ShieldCheck, ShieldOff, Star, Settings, Search, UserCheck, Lock, X, ArrowLeft, MoreVertical, BellOff, Bell, Trash2, Megaphone } from 'lucide-react'
import { MobileBottomNav, type MobileNavTab } from '@/components/chat/mobile-bottom-nav'
import { useAuth } from '@/components/auth/auth-provider'
import { getFmSocket } from '@/lib/api/socket'
import { runPostLoginVaultSync } from '@/lib/vault-sync'
import { useShallow } from 'zustand/shallow'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { usePresenceStore } from '@/store/presenceStore'
import { useUnreadStore } from '@/store/unreadStore'
import { useCallStore } from '@/store/callStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useCryptoVault } from '@/hooks/use-crypto-vault'
import { useSendMessage } from '@/hooks/use-send-message'
import { useSendMediaMessage } from '@/hooks/use-send-media-message'
import { useMessages } from '@/hooks/use-messages'
import { useChatAesKey } from '@/hooks/use-chat-aes-key'
import {
  fetchChatDetail,
  fetchPeerIdsForChat,
  setChatMute,
  isChatMuted,
  deleteChat,
  type ChatMemberRole,
} from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { canonicalUserId } from '@/lib/user-id'
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'
import { hashPublicKeyJwk } from '@/lib/crypto'
import { resolveTrustStatus } from '@/lib/trust-store'
import { useChats } from '@/hooks/use-chats'
import { usePresenceSync } from '@/hooks/use-presence-sync'
import { useGroupKeyDistribution } from '@/hooks/use-group-key-distribution'
import { CallAudioSink } from '@/components/call/call-audio-sink'
import { useWebRTC } from '@/hooks/use-webrtc'
import { NoLocalVault } from '@/components/chat/no-local-vault'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { useDockStore, matchesDockViewport } from '@/store/dockStore'
import { resolveMobileNavAction, requestSidebarFolder } from '@/lib/mobile-nav'
import { ChatSearchPanel } from '@/components/chat/chat-search-panel'
import { scrollToMessage } from '@/lib/chat-scroll'
import { acquireBodyScrollLock } from '@/lib/body-scroll-lock'
import { OfflineBanner } from '@/components/offline-banner'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'
import { useCapabilities } from '@/components/capabilities-provider'
import { IdentityModal } from '@/components/chat/identity-modal'
import { UserProfileModal } from '@/components/chat/user-profile-modal'
import { PwaInstallBanner } from '@/components/pwa-install-banner'
import { PushOnboardingBanner } from '@/components/push-onboarding-banner'
import { BackupReminderBanner } from '@/components/chat/backup-reminder-banner'
import { InviteChatLinkEffect } from '@/components/chat/invite-chat-link-effect'
import { useTranslation } from '@/hooks/use-translation'
import { usePhantomPush } from '@/hooks/use-phantom-push'
import { useAutoLock } from '@/hooks/use-auto-lock'
import { useCallPwa } from '@/hooks/use-call-pwa'
import { useAppBadge } from '@/hooks/use-app-badge'
import { MEDIA_PERMISSION_DENIED_CODE } from '@/lib/media-limits'
import { useGroupCall } from '@/hooks/use-group-call'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useMobileViewport } from '@/hooks/use-mobile-viewport'
import { useNotificationOpen } from '@/hooks/use-notification-open'
import { useThemeStore } from '@/store/themeStore'
import { isApprovedContact } from '@/lib/contacts-store'
import { UserAvatar } from '@/components/user-avatar'
import { TELEGRAM_BEHAVIOR } from '@/components/chat/telegram-behavior'
import {
  getStoredNotificationMode,
  installPushRecoveryListener,
  supportsNativePush,
} from '@/lib/push-subscription'
import { NotificationModeOnboarding } from '@/components/notification-mode-onboarding'
import { requestAndroidEssentialPermissionsOnce } from '@/lib/native-permissions'
import { patchMutedChat } from '@/lib/muted-chats'

const VaultModal = dynamic(
  () => import('@/components/chat/vault-modal').then((m) => m.VaultModal),
  { ssr: false }
)
const ChatSidebar = dynamic(
  () => import('@/components/chat/chat-sidebar').then((m) => m.ChatSidebar),
  { ssr: false }
)
const SettingsModal = dynamic(
  () => import('@/components/settings-modal').then((m) => m.SettingsModal),
  { ssr: false }
)
const StartGuide = dynamic(
  () => import('@/components/onboarding/start-guide').then((m) => m.StartGuide),
  { ssr: false }
)
const IncomingCallModal = dynamic(
  () =>
    import('@/components/call/incoming-call-modal').then(
      (m) => m.IncomingCallModal
    ),
  { ssr: false }
)
const ActiveCallOverlay = dynamic(
  () =>
    import('@/components/call/active-call-overlay').then(
      (m) => m.ActiveCallOverlay
    ),
  { ssr: false }
)
const GroupCallScreen = dynamic(
  () =>
    import('@/components/call/group-call-screen').then(
      (m) => m.GroupCallScreen
    ),
  { ssr: false }
)
const CallMiniPlayer = dynamic(
  () =>
    import('@/components/call/call-mini-player').then(
      (m) => m.CallMiniPlayer
    ),
  { ssr: false }
)
const GroupCallMiniPlayer = dynamic(
  () =>
    import('@/components/call/group-call-mini-player').then(
      (m) => m.GroupCallMiniPlayer
    ),
  { ssr: false }
)
const GroupCallBanner = dynamic(
  () =>
    import('@/components/call/group-call-banner').then(
      (m) => m.GroupCallBanner
    ),
  { ssr: false }
)

/** Right dock (xl+ only). Loaded lazily so `emoji-picker-react` is not evaluated on every mobile session — some WebViews crash on that import. */
const DockPanel = dynamic(
  () => import('@/components/chat/dock-panel').then((m) => m.DockPanel),
  { ssr: false, loading: () => null }
)

const DESKTOP_MIN_MAIN_PANE_WIDTH = 352
const DESKTOP_FRAME_GUTTER = 16
const DOCK_PANEL_RESERVE_WIDTH = 360
const SIDEBAR_COLLAPSE_THRESHOLD =
  Math.round((TELEGRAM_BEHAVIOR.sidebar.minWidth + TELEGRAM_BEHAVIOR.sidebar.collapsedWidth) / 2)

export function ChatApp({
  userId,
  username,
}: {
  userId: string
  username: string
}) {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  const searchParams = useSearchParams()
  const setUserId = useSessionStore((s) => s.setUserId)
  const setSelfUsername = useSessionStore((s) => s.setSelfUsername)
  const selfUsername = useSessionStore((s) => s.selfUsername)
  const setActiveChatId = useSessionStore((s) => s.setActiveChatId)
  const setUnwrappedPrivateKey = useSessionStore((s) => s.setUnwrappedPrivateKey)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const historyDecryptBusy = useUnreadStore((s) => s.historyDecryptBusy)
  const unreadTotal = useUnreadStore((s) => s.unreadTotal)
  const unreadByChat = useUnreadStore((s) => s.unreadByChat)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const [peerIdentity, setPeerIdentity] = useState<{
    userId: string
    username: string
    ecdhPublicKeyJwk: string
    verified: boolean
  } | null>(null)
  // Take the public JWK from the session store, NOT by re-deriving it from the
  // CryptoKey: `unwrappedPrivateKey` is imported with extractable:false (Stage-1
  // isolation), so exportKey('jwk') threw InvalidAccessError on every run, the
  // catch pinned this to null forever, and the render guard below therefore
  // never passed — the safety number, the peer fingerprint, the TOFU
  // "identity changed" banner and the manual trust-pin button were all silently
  // unreachable. activate-vault already computes the same value from the JWK
  // *string* while it still has it.
  const myEcdhPublicKeyJwk = useSessionStore((s) => s.myEcdhPublicKeyJwk)
  const [showGuide, setShowGuide] = useState(() => {
    if (typeof window === 'undefined') return false
    return !localStorage.getItem(`p13:onboarded:${userId}`)
  })
  const [showNotificationModeOnboarding, setShowNotificationModeOnboarding] = useState(false)
  useAutoLock()
  useMobileViewport()
  useAppBadge(userId)
  const vaultState = useCryptoVault(userId, user?.username ?? username)
  const { chats, reload, patchChat } = useChats(userId)
  usePresenceSync(userId, chats)
  const [memberRoleByUser, setMemberRoleByUser] = useState<
    Record<string, ChatMemberRole>
  >({})
  const [groupDetailTick, setGroupDetailTick] = useState(0)
  const [peerAvatarKey, setPeerAvatarKey] = useState<string | null>(null)
  const [peerApproved, setPeerApproved] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileNavTab, setMobileNavTab] = useState<MobileNavTab>('chats')
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [headerProfileOpen, setHeaderProfileOpen] = useState(false)
  const [md3HeaderCondensed, setMd3HeaderCondensed] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  const chatMenuRef = useRef<HTMLDivElement>(null)
  const dockSlot = useDockStore((s) => s.slot)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  const [sidebarWidth, setSidebarWidth] = useState(344)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const clampSidebarWidthForViewport = useCallback((requested: number) => {
    const bounded = Math.min(
      TELEGRAM_BEHAVIOR.sidebar.maxWidth,
      Math.max(TELEGRAM_BEHAVIOR.sidebar.minWidth, requested)
    )
    if (typeof window === 'undefined') return bounded
    if (!window.matchMedia('(min-width: 768px)').matches) return bounded
    const dockReserve = matchesDockViewport() && dockSlot ? DOCK_PANEL_RESERVE_WIDTH : 0
    const viewportMax = window.innerWidth - dockReserve - DESKTOP_MIN_MAIN_PANE_WIDTH - DESKTOP_FRAME_GUTTER
    const maxAllowed = Math.max(
      TELEGRAM_BEHAVIOR.sidebar.minWidth,
      Math.min(TELEGRAM_BEHAVIOR.sidebar.maxWidth, viewportMax)
    )
    return Math.min(maxAllowed, bounded)
  }, [dockSlot])
  useLayoutEffect(() => {
    const saved = localStorage.getItem('p13_sidebar_width')
    if (!saved) return
    const n = Number(saved)
    if (Number.isFinite(n) && n >= TELEGRAM_BEHAVIOR.sidebar.minWidth && n <= TELEGRAM_BEHAVIOR.sidebar.maxWidth) {
      setSidebarWidth(clampSidebarWidthForViewport(n))
    }
  }, [clampSidebarWidthForViewport])
  useLayoutEffect(() => {
    const saved = localStorage.getItem('p13_sidebar_collapsed')
    if (!saved) return
    setSidebarCollapsed(saved === '1')
  }, [])

  const applySidebarDragState = useCallback((requested: number, persist: boolean) => {
    if (requested <= SIDEBAR_COLLAPSE_THRESHOLD) {
      setSidebarCollapsed(true)
      if (persist) {
        localStorage.setItem('p13_sidebar_collapsed', '1')
      }
      return
    }
    const next = clampSidebarWidthForViewport(requested)
    setSidebarCollapsed(false)
    setSidebarWidth(next)
    if (persist) {
      localStorage.setItem('p13_sidebar_width', String(next))
      localStorage.setItem('p13_sidebar_collapsed', '0')
    }
  }, [clampSidebarWidthForViewport])

  const handleSidebarResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const startX = e.clientX
    const startWidth = sidebarCollapsed ? TELEGRAM_BEHAVIOR.sidebar.collapsedWidth : sidebarWidth
    sidebarDragRef.current = { startX, startWidth }
    setSidebarResizeActive(true)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (mv: PointerEvent) => {
      const delta = mv.clientX - startX
      applySidebarDragState(startWidth + delta, false)
    }
    const onUp = (up: PointerEvent) => {
      const delta = up.clientX - startX
      applySidebarDragState(startWidth + delta, true)
      sidebarDragRef.current = null
      setSidebarResizeActive(false)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [applySidebarDragState, sidebarCollapsed, sidebarWidth])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const syncSidebarWidth = () => {
      setSidebarWidth((current) => clampSidebarWidthForViewport(current))
    }
    syncSidebarWidth()
    window.addEventListener('resize', syncSidebarWidth)
    return () => window.removeEventListener('resize', syncSidebarWidth)
  }, [clampSidebarWidthForViewport])

  const setSidebarCollapsedPersisted = useCallback((next: boolean) => {
    setSidebarCollapsed(next)
    localStorage.setItem('p13_sidebar_collapsed', next ? '1' : '0')
  }, [])

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsedPersisted(!sidebarCollapsed)
  }, [setSidebarCollapsedPersisted, sidebarCollapsed])

  const openMobileSidebar = useCallback(() => {
    setMobileSearchOpen(false)
    setMobileSidebarOpen(true)
  }, [])

  const handleMobileNavTabChange = useCallback((tab: MobileNavTab) => {
    setMobileNavTab(tab)
    const action = resolveMobileNavAction(tab)
    if (action.kind === 'settings') {
      setSettingsOpen(true)
      return
    }
    // Sidebar tabs: open the chat-list overlay and focus the matching system
    // folder. `requestSidebarFolder` both broadcasts the change and retains it
    // so the lazily-mounted sidebar can reconcile if it isn't listening yet.
    openMobileSidebar()
    requestSidebarFolder(action.folderId)
  }, [openMobileSidebar])
  const closeMobileOverlays = useCallback(() => {
    setMobileSidebarOpen(false)
    setMobileSearchOpen(false)
    setHeaderProfileOpen(false)
  }, [])
  const mobileOverlayOpen = mobileSidebarOpen || mobileSearchOpen || headerProfileOpen

  const openPeerProfile = useCallback((peerUserId: string) => {
    if (matchesDockViewport()) {
      const store = useDockStore.getState()
      if (store.slot === 'profile' && store.profileUserId === peerUserId) {
        store.close()
      } else {
        store.openProfile(peerUserId)
      }
      return
    }
    setHeaderProfileOpen(true)
  }, [])

  const toggleSearchSurface = useCallback(() => {
    if (!activeChatId) return
    if (matchesDockViewport()) {
      const store = useDockStore.getState()
      if (store.slot === 'search') {
        store.close()
      } else {
        store.openSearch(activeChatId, (id) => scrollToMessage(id))
      }
      return
    }
    setMobileSidebarOpen(false)
    setMobileSearchOpen((v) => !v)
  }, [activeChatId])

  const {
    peerReady,
    mediaAccessError,
    clearMediaAccessError,
    initiateCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMuteMic,
    toggleCamera,
    isCameraOn,
    listCameras,
    switchCamera,
    isScreenSharing,
    toggleScreenShare,
    localScreenStream,
    hasScreenAudio,
    isScreenAudioMuted,
    toggleScreenAudioMuted,
    setQuality,
    setCameraEffect,
    promoteToGroup,
  } = useWebRTC(userId)

  useNotificationOpen(acceptIncomingCall)

  const {
    isInGroupCall,
    activeCallBanner,
    startCall: startGroupCall,
    endCall: endGroupCall,
    toggleMute: toggleGroupMute,
    toggleVideo: toggleGroupVideo,
    toggleScreenShare: toggleGroupScreenShare,
  } = useGroupCall(userId)

  const groupCallIsMiniPlayer = useGroupCallStore((s) => s.isMiniPlayer)

  const callLocalStream = useCallStore((s) => s.localStream)
  const callIsVideo = (callLocalStream?.getVideoTracks().length ?? 0) > 0
  const callRemoteStreams = useCallStore((s) => s.remoteStreams)
  const callIsCalling = useCallStore((s) => s.isCalling)
  const callIsMiniPlayer = useCallStore((s) => s.isMiniPlayer)
  const callChatOpen = useCallStore((s) => s.chatOpen)
  const setCallChatOpen = useCallStore((s) => s.setChatOpen)

  // In-call side chat (Discord-style): visible while a full-screen call surface
  // is up and the user toggled the chat button. The overlay shrinks to make
  // room (see ActiveCallOverlay/GroupCallScreen), this panel fills the gap with
  // the REAL chat — full compose/media/replies, not a stripped-down copy.
  const callSurfaceFullscreen =
    (callIsCalling && !callIsMiniPlayer) || (isInGroupCall && !groupCallIsMiniPlayer)
  const showCallSideChat = callChatOpen && callSurfaceFullscreen

  // Reset the flag when every call surface is gone so the next call doesn't
  // start with a phantom open panel.
  useEffect(() => {
    if (!callIsCalling && !isInGroupCall && callChatOpen) setCallChatOpen(false)
  }, [callIsCalling, isInGroupCall, callChatOpen, setCallChatOpen])

  // Direct-chat contacts that can be pulled into the current 1:1 call (#4):
  // everyone we have a direct chat with, minus ourselves and whoever is already
  // in the call. Usernames are resolved by the overlay's picker on open.
  const promoteCandidateIds = useMemo(() => {
    const inCall = new Set(Object.keys(callRemoteStreams).map(canonicalUserId))
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of chats) {
      if (c.is_group || c.is_self || c.type !== 'direct_e2e') continue
      const peer = c.member_ids.find((id) => canonicalUserId(id) !== canonicalUserId(userId))
      if (!peer) continue
      const cid = canonicalUserId(peer)
      if (inCall.has(cid) || seen.has(cid)) continue
      seen.add(cid)
      out.push(peer)
    }
    return out
  }, [chats, callRemoteStreams, userId])
  useCallPwa({
    peerUsername: peerIdentity?.username ?? null,
    onEndCall: endCall,
    onToggleMute: toggleMuteMic,
    isVideo: callIsVideo,
  })

  useLayoutEffect(() => {
    setUserId(userId)
    setSelfUsername(user?.username ?? username ?? null)
  }, [setSelfUsername, setUserId, user?.username, userId, username])

  useEffect(() => {
    if (!unwrappedPrivateKey || !userId) return
    void runPostLoginVaultSync(userId)
  }, [userId, unwrappedPrivateKey])

  useEffect(() => {
    const socket = getFmSocket()
    return socket.subscribe((m) => {
      if (m.type !== 'server_notice') return
      if (
        m.notice === 'device_revoked' &&
        m.device_id &&
        user?.device_id &&
        m.device_id === user.device_id
      ) {
        void logout()
        window.location.href = '/login'
        return
      }
    })
  }, [user?.device_id, logout])

  useEffect(() => {
    const chat = searchParams.get('chat')
    if (chat) setActiveChatId(chat)
  }, [searchParams, setActiveChatId])

  useEffect(() => {
    if (activeChatId) {
      // Chat opened — hide mobile overlay
      setMobileSidebarOpen(false)
      setMobileSearchOpen(false)
      setHeaderProfileOpen(false)
    } else {
      // No chat selected — on narrow screens auto-show the chat list
      const isMobileWidth = typeof window !== 'undefined' && window.innerWidth < 768
      if (isMobileWidth) {
        setMobileSidebarOpen(true)
      }
    }
    if (!activeChatId && matchesDockViewport()) {
      const store = useDockStore.getState()
      if (store.slot === 'search' || store.slot === 'profile') store.close()
    }
  }, [activeChatId])

  useEffect(() => {
    if (!mobileOverlayOpen) return
    return acquireBodyScrollLock()
  }, [mobileOverlayOpen])

  useEffect(() => {
    if (!mobileOverlayOpen) return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeMobileOverlays()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileOverlayOpen, closeMobileOverlays])

  useEffect(() => {
    if (!activeChatId || !matchesDockViewport()) return
    const store = useDockStore.getState()
    if (store.slot === 'search' && store.searchScopeChatId && store.searchScopeChatId !== activeChatId) {
      store.close()
    }
  }, [activeChatId])

  useEffect(() => {
    setIsOnline(window.navigator.onLine)
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    return installPushRecoveryListener()
  }, [])

  // Mark <html> while the chat shell is mounted. The chat owns a fixed-height,
  // internally-scrolling layout, so on mobile it needs `overflow: hidden` on
  // html/body to suppress page bounce. That rule must NOT leak onto long-form
  // routes (login, legal/privacy, legal/terms) which rely on normal page
  // scroll — scoping it to `[data-chat-shell]` keeps those pages scrollable.
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-chat-shell', 'true')
    return () => root.removeAttribute('data-chat-shell')
  }, [])

  useEffect(() => {
    void requestAndroidEssentialPermissionsOnce()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!supportsNativePush()) return
    if (getStoredNotificationMode()) return
    setShowNotificationModeOnboarding(true)
  }, [])

  useEffect(() => {
    if (!isMd3) {
      setMd3HeaderCondensed(false)
      return
    }
    const onScrollCapture = (ev: Event) => {
      // A document-level scroll event's target is the Document, which has no
      // `.closest` — guard on Element or this throws "closest is not a function"
      // on every non-chat scroll (it fired constantly in the production build).
      const target = ev.target
      if (!(target instanceof Element)) return
      const scroller = target.closest('.chat-scroll, .custom-scrollbar') as HTMLElement | null
      if (!scroller) return
      setMd3HeaderCondensed(scroller.scrollTop > 20)
    }
    document.addEventListener('scroll', onScrollCapture, true)
    return () => document.removeEventListener('scroll', onScrollCapture, true)
  }, [isMd3])

  useEffect(() => {
    if (!activeChatId || !userId) {
      setPeerIdentity(null)
      setPeerApproved(false)
      return
    }
    const active = chats.find((c) => c.id === activeChatId)
    if (!active || active.is_group) {
      setPeerIdentity(null)
      setPeerApproved(false)
      return
    }
    const peerId = active.member_ids.find(
      (id) => canonicalUserId(id) !== canonicalUserId(userId)
    )
    if (!peerId) {
      setPeerIdentity(null)
      setPeerApproved(false)
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const rows = await lookupUsers([peerId])
        const row = rows[0]
        if (!row?.ecdh_public_key_jwk || cancelled) {
          if (!cancelled) setPeerIdentity(null)
          return
        }
        const jwk = JSON.parse(row.ecdh_public_key_jwk) as JsonWebKey
        const hash = await hashPublicKeyJwk(jwk)
        const trust = resolveTrustStatus(peerId, hash)
        if (cancelled) return
        setPeerIdentity({
          userId: row.id,
          username: row.username,
          ecdhPublicKeyJwk: row.ecdh_public_key_jwk,
          verified: trust.verified,
        })
        setPeerApproved(isApprovedContact(peerId))
      } catch {
        if (!cancelled) {
          setPeerIdentity(null)
          setPeerApproved(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [activeChatId, chats, userId])

  useEffect(() => {
    if (!activeChatId || !userId) {
      setPeerAvatarKey(null)
      return
    }
    const active = chats.find((c) => c.id === activeChatId)
    if (!active || active.is_group) {
      setPeerAvatarKey(null)
      return
    }
    const peerId = active.member_ids.find(
      (id) => canonicalUserId(id) !== canonicalUserId(userId)
    )
    if (!peerId) {
      setPeerAvatarKey(null)
      return
    }
    let cancelled = false
    void lookupUsers([peerId])
      .then((rows) => {
        if (cancelled) return
        setPeerAvatarKey(rows[0]?.avatar_key ?? null)
      })
      .catch(() => { if (!cancelled) setPeerAvatarKey(null) })
    return () => { cancelled = true }
  }, [activeChatId, chats, userId])

  const { cryptoCtx, ctxError } = useChatCryptoContext()
  const { emitPhantomSignal } = usePhantomPush()
  const sharedKey = useChatAesKey(cryptoCtx)
  // Derive peer ID synchronously from the chat list so drCtx is available
  // immediately on chat switch — don't wait for the async peerIdentity lookup.
  const directPeerUserId = (() => {
    const row = chats.find((c) => c.id === activeChatId)
    if (!row || row.is_group) return null
    return (
      row.member_ids.find(
        (id) => canonicalUserId(id) !== canonicalUserId(userId)
      ) ?? null
    )
  })()
  useMessages(cryptoCtx, emitPhantomSignal, directPeerUserId)
  const { sendText } = useSendMessage(cryptoCtx, directPeerUserId)
  const { sendMedia: rawSendMedia, sendAlbum: rawSendAlbum } = useSendMediaMessage(cryptoCtx, directPeerUserId)

  const sendMedia = useCallback(
    async (
      blob: Blob,
      mediaType: 'audio' | 'video' | 'image' | 'file',
      caption?: string,
      options?: {
        fileName?: string
        fileType?: string
        kind?: import('@/lib/attachment-envelope').AttachmentKind
        sendOriginal?: boolean
        burn_duration_secs?: number | null
        durationMs?: number
        waveform?: number[]
      },
    ) => {
      await rawSendMedia(blob, mediaType, {
        label: options?.fileName,
        mime: options?.fileType,
        caption: caption?.trim() || undefined,
        ...(options?.kind ? { kind: options.kind } : {}),
        ...(options?.sendOriginal ? { sendOriginal: true } : {}),
        // Forward the burn timer (was previously dropped here) and the
        // record-time duration/waveform metadata (issue #11).
        ...(options?.burn_duration_secs != null
          ? { burn_duration_secs: options.burn_duration_secs }
          : {}),
        ...(typeof options?.durationMs === 'number'
          ? { durationMs: options.durationMs }
          : {}),
        ...(options?.waveform && options.waveform.length
          ? { waveform: options.waveform }
          : {}),
      })
    },
    [rawSendMedia],
  )

  const sendAlbum = useCallback(
    async (
      items: Array<{
        blob: Blob
        segmentClass: 'audio' | 'video' | 'image' | 'file'
        options?: {
          label?: string
          mime?: string
          kind?: import('@/lib/attachment-envelope').AttachmentKind
          sendOriginal?: boolean
        }
      }>,
      caption?: string,
    ) => {
      await rawSendAlbum(items, caption)
    },
    [rawSendAlbum],
  )
  useGroupKeyDistribution(cryptoCtx, reload)

  useEffect(() => {
    const tick = () => useChatStore.getState().pruneBurnedMessages()
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!chatMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (chatMenuRef.current && !chatMenuRef.current.contains(e.target as Node)) {
        setChatMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [chatMenuOpen])

  const activeRow = chats.find((c) => c.id === activeChatId) ?? null
  const isSelfChat = activeRow != null && isSavedMessagesChat(activeRow, userId)
  // Channel subscriber gating: subscribers cannot post; editors/owners can
  const isChannel = activeRow?.type === 'channel'
  const myChannelRole = activeRow?.my_channel_role ?? null
  const isChannelSubscriber = isChannel && myChannelRole === 'subscriber'
  const { typingUsers, peerPresence } = usePresenceStore(
    useShallow((s) => ({
      typingUsers: s.typingUsers,
      peerPresence: s.peerPresence,
    }))
  )

  const directPeerIdForPresence =
    activeRow && !activeRow.is_group
      ? activeRow.member_ids.find(
          (id) => canonicalUserId(id) !== canonicalUserId(userId)
        ) ?? null
      : null
  const peerPresenceRow = directPeerIdForPresence
    ? peerPresence[directPeerIdForPresence]
    : undefined
  // Feature capabilities of this instance (Lite self-host) — hide surfaces the
  // server disabled so there are no dead buttons. Defaults ON (full build).
  const capabilities = useCapabilities()
  const canShowCallControls =
    capabilities.calls &&
    !!activeChatId && !!activeRow && !activeRow.is_group && !isSelfChat
  // Group voice room: the Call button must ALSO render in group chats — it is the
  // only entry point to start a room. Without it the group_call:active JOIN banner
  // can never appear (nobody can be first to join). onCall already routes is_group
  // → handleGroupCall. Broadcast channels are excluded.
  const canStartGroupCall =
    capabilities.calls &&
    !!activeChatId && !!activeRow && activeRow.is_group && !isChannel && !isSelfChat
  const canUseCallButton = canShowCallControls || canStartGroupCall
  const mentionTotal = Object.values(unreadByChat).reduce(
    (acc, row) => acc + (row.mentions ?? 0),
    0
  )

  const scratchers = activeChatId
    ? Object.values(typingUsers[activeChatId] ?? {})
    : []

  function formatLastSeen(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  useEffect(() => {
    if (!activeChatId || !activeRow?.is_group) {
      setMemberRoleByUser({})
      return
    }
    let cancelled = false
    void fetchChatDetail(activeChatId)
      .then((d) => {
        if (cancelled) return
        const next: Record<string, ChatMemberRole> = {}
        for (const m of d.members) next[m.user_id] = m.role
        setMemberRoleByUser(next)
      })
      .catch(() => { if (!cancelled) setMemberRoleByUser({}) })
    return () => { cancelled = true }
  }, [activeChatId, activeRow?.is_group, groupDetailTick])

  async function handleMuteChat(until: string | 'forever' | null) {
    if (!activeChatId) return
    try {
      const result = await setChatMute(activeChatId, until)
      patchChat(activeChatId, { muted_until: result.muted_until })
      patchMutedChat(activeChatId, result.muted_until)
    } catch {
      // ignore
    }
    setChatMenuOpen(false)
  }

  async function handleDeleteChat() {
    if (!activeChatId) return
    if (!window.confirm(t('chat.confirmDelete'))) return
    try {
      await deleteChat(activeChatId)
      setActiveChatId(null)
      await reload()
    } catch {
      // ignore
    }
    setChatMenuOpen(false)
  }

  // Single call entry point. Calls always start audio-only; video and
  // screen-share are opt-in from the in-call controls.
  async function handleCall() {
    if (!activeChatId) return
    const peers = await fetchPeerIdsForChat(activeChatId, userId)
    if (peers.length === 0) return
    await initiateCall(peers, false, activeChatId)
  }

  async function handleGroupCall() {
    if (!activeChatId) return
    await startGroupCall(activeChatId, false)
  }

  if (vaultState === 'loading') {
    return <div className="min-h-screen bg-void" aria-hidden />
  }

  if (vaultState === 'missing') {
    return <NoLocalVault />
  }

  if (!unwrappedPrivateKey) {
    return (
      <VaultModal
        userId={userId}
        displayHandle={user?.username ?? username}
      />
    )
  }

  return (
    <div className="chat-safe-shell p13-app-shell flex min-h-0 flex-col overflow-hidden bg-void">
      <InviteChatLinkEffect userId={userId} />
      {/* Call surfaces — rendered only when this instance runs calls (Lite
          self-host). Gating the render (not just the outbound buttons) also stops
          a peer's call_invite / group_call:active from popping a live incoming
          ring, active overlay, or JOIN banner on a calls-disabled instance. */}
      {capabilities.calls ? (
      <>
      <IncomingCallModal
        onAccept={() => void acceptIncomingCall()}
        onReject={rejectIncomingCall}
      />
      {/* Always-mounted remote-audio sink — plays peer audio independent of the
          overlay/mini-player, so minimizing a call no longer drops the peer's
          voice (issue #3). Tiles below render video only. */}
      <CallAudioSink />
      <ActiveCallOverlay
        onEndCall={endCall}
        onToggleMute={toggleMuteMic}
        onToggleCamera={() => void toggleCamera()}
        isCameraOn={isCameraOn}
        onListCameras={listCameras}
        onSelectCamera={(deviceId) => void switchCamera(deviceId)}
        onFlipCamera={() => void switchCamera()}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={() => void toggleScreenShare()}
        localScreenStream={localScreenStream}
        hasScreenAudio={hasScreenAudio}
        isScreenAudioMuted={isScreenAudioMuted}
        onToggleScreenAudio={toggleScreenAudioMuted}
        onSetQuality={setQuality}
        onSetCameraEffect={(kind) => void setCameraEffect(kind)}
        peerName={peerIdentity?.username ?? undefined}
        promoteCandidateIds={promoteCandidateIds}
        onPromote={promoteToGroup}
      />
      <CallMiniPlayer
        onExpand={() => useCallStore.getState().setMiniPlayer(false)}
        onEndCall={endCall}
        onToggleMute={toggleMuteMic}
        peerName={peerIdentity?.username ?? undefined}
      />
      {isInGroupCall && !groupCallIsMiniPlayer && (
        <GroupCallScreen
          userId={userId}
          username={user?.username ?? username}
          onEndCall={endGroupCall}
          onToggleMute={toggleGroupMute}
          onToggleVideo={toggleGroupVideo}
          onToggleScreenShare={toggleGroupScreenShare}
        />
      )}
      {isInGroupCall && groupCallIsMiniPlayer && (
        <GroupCallMiniPlayer
          onExpand={() => useGroupCallStore.getState().setIsMiniPlayer(false)}
          onEndCall={endGroupCall}
          onToggleMute={toggleGroupMute}
        />
      )}
      {showCallSideChat ? (
        <div className="fixed inset-y-0 right-0 z-[201] hidden w-[min(400px,45vw)] flex-col border-l border-border-strong bg-void min-[901px]:flex">
          <div className="flex shrink-0 items-center justify-between border-b border-border-strong px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.2em] text-neon-cyan">
              {activeRow?.name || peerIdentity?.username || t('call.chatTitle')}
            </span>
            <button
              type="button"
              onClick={() => setCallChatOpen(false)}
              className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatTerminal
              userId={userId}
              sharedKey={sharedKey}
              currentUsername={user?.username ?? username}
              activeChat={activeRow}
              directPeerUsername={peerIdentity?.username ?? null}
              senderRoles={memberRoleByUser}
              myAvatarKey={user?.avatar_key ?? null}
              peerAvatarKey={peerAvatarKey}
              cryptoCtx={cryptoCtx}
              sendText={sendText}
              sendMedia={sendMedia}
              sendAlbum={sendAlbum}
              directPeerUserId={directPeerUserId}
              composeDisabled={!activeChatId || !!ctxError || isChannelSubscriber}
            />
          </div>
        </div>
      ) : null}
      </>
      ) : null}

      {showGuide ? (
        <StartGuide
          onComplete={() => {
            localStorage.setItem(`p13:onboarded:${userId}`, '1')
            setShowGuide(false)
          }}
        />
      ) : null}
      {capabilities.push ? (
        <NotificationModeOnboarding
          open={showNotificationModeOnboarding}
          onDone={() => setShowNotificationModeOnboarding(false)}
        />
      ) : null}
      <OfflineBanner />
      <PwaInstallBanner />
      {settingsOpen ? (
        <SettingsModal
          userId={userId}
          username={username}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {identityOpen && peerIdentity && myEcdhPublicKeyJwk ? (
        <IdentityModal
          peerUserId={peerIdentity.userId}
          peerUsername={peerIdentity.username}
          peerEcdhPublicKeyJwk={peerIdentity.ecdhPublicKeyJwk}
          myEcdhPublicKeyJwk={myEcdhPublicKeyJwk}
          myUserId={userId ?? undefined}
          onClose={() => setIdentityOpen(false)}
          onTrustChanged={(verified) =>
            setPeerIdentity((prev) =>
              prev ? { ...prev, verified } : prev
            )
          }
          onContactApprovedChanged={setPeerApproved}
        />
      ) : null}
      {headerProfileOpen && peerIdentity ? (
        <UserProfileModal
          userId={peerIdentity.userId}
          username={peerIdentity.username}
          avatarKey={peerAvatarKey}
          onClose={() => setHeaderProfileOpen(false)}
          onMessage={() => setHeaderProfileOpen(false)}
        />
      ) : null}

      {/* Mobile per-chat search overlay. On xl+ we render the same panel in
          the right dock (see DockPanel / `openSearch`); on narrower screens
          we use a full-height sheet so the chat stays reachable behind it. */}
      {mobileSearchOpen ? (
        <div
          className="p13-search-overlay fixed inset-0 z-[120] flex flex-col bg-void/95 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] backdrop-blur-sm motion-safe:animate-[p13-mobile-sheet-in_var(--motion-base)_ease-out] xl:hidden"
          style={{ animationDuration: 'var(--p13-mobile-sheet-duration, 220ms)' }}
          role="dialog"
          aria-modal="true"
          aria-label={t('chatSearch.title')}
        >
          <ChatSearchPanel
            onClose={closeMobileOverlays}
            onJumpToMessage={(id) => {
              closeMobileOverlays()
              scrollToMessage(id)
            }}
          />
        </div>
      ) : null}

      {/* ─── HEADER ────────────────────────────────────────────────────────────────────────── */}
      <header
        className={`p13-header chat-header-compact flex shrink-0 items-center gap-2 px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:hidden ${isMd3 ? `md3-top-appbar ${md3HeaderCondensed ? 'md3-top-appbar--condensed' : ''}` : ''}`}
        style={{ minHeight: `${TELEGRAM_BEHAVIOR.mobile.headerHeightPx}px` }}
      >

        {/* Back/Burger — mobile only */}
        {activeChatId ? (
          <button
            type="button"
            className="p13-icon-btn touch-manipulation md:hidden"
            aria-label={t('common.back')}
            onClick={() => setActiveChatId(null)}
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={1.5} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="p13-icon-btn touch-manipulation md:hidden"
            aria-label={t('call.openChannels')}
            onClick={openMobileSidebar}
          >
            <Menu className="h-5 w-5" strokeWidth={1.5} aria-hidden />
          </button>
        )}

        {/* CENTER: peer nick — always visible, takes remaining space */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {isSelfChat ? (
            <div className={`flex h-9 min-w-0 items-center gap-1.5 px-3 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-accent-2/40 bg-void tracking-[0.2em] text-accent-2'}`}>
              <Star className="h-3.5 w-3.5 fill-accent-2 shrink-0" />
              <span className="truncate">{t('sidebar.savedMessages')}</span>
            </div>
          ) : peerIdentity ? (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              {/* Peer nick button */}
              <button
                type="button"
                onClick={() => {
                  // Prefer the right-dock profile slot on xl+ viewports so
                  // the chat stays visible; fall back to the legacy modal
                  // on narrower screens. See `DOCK_BREAKPOINT` in dockStore.
                  openPeerProfile(peerIdentity.userId)
                }}
                className={`touch-manipulation inline-flex h-9 min-w-0 items-center gap-1.5 px-3 text-[11px] font-bold transition-colors ${
                  isMd3
                    ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                    : 'border border-neon-cyan/40 bg-void tracking-wider text-neon-cyan hover:border-neon-red hover:text-neon-red'
                }`}
              >
                {peerIdentity.verified ? (
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Verified &amp; end-to-end encrypted" />
                ) : (cryptoCtx?.mode === 'DIRECT' || cryptoCtx?.mode === 'SELF') ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-success" aria-label="End-to-end encrypted" />
                ) : cryptoCtx?.mode === 'PUBLIC' ? (
                  <ShieldOff className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="Not end-to-end encrypted" />
                ) : null}
                {peerApproved ? (
                  <UserCheck className="h-3.5 w-3.5 shrink-0 text-accent-2" />
                ) : null}
                <span className="truncate max-w-[140px] md:max-w-xs">@{peerIdentity.username}</span>
              </button>
              {/* Presence */}
              {peerPresenceRow ? (
                <span className="hidden sm:inline-flex items-center gap-1.5 font-mono text-[9px] normal-case tracking-normal">
                  {peerPresenceRow.online ? (
                    <>
                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-neon-cyan/15 shadow-[0_0_8px_rgba(34,211,238,0.85)]" />
                      <span className="text-neon-cyan/75">{t('presence.online')}</span>
                    </>
                  ) : (
                    <span className="text-danger/90 whitespace-nowrap">
                      {formatLastSeen(peerPresenceRow.last_seen_at)}
                    </span>
                  )}
                </span>
              ) : null}
            </div>
          ) : (
            /* No active chat — show username + online status */
            <div className="flex items-center gap-2 min-w-0">
              <span className={`truncate text-[11px] font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan/80 tracking-wider'}`}>
                @{selfUsername ?? '…'}
              </span>
              <span className={`hidden sm:flex items-center gap-1 font-mono text-[9px] ${isMd3 ? 'text-text-muted' : 'text-neon-cyan/50'}`}>
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-neon-cyan/20 shadow-[0_0_6px_rgba(34,211,238,0.7)]" />
                {t('presence.online')}
              </span>
            </div>
          )}
        </div>

        {/* RIGHT: calls block + separator + settings icon */}
        <div className="flex shrink-0 items-center gap-1.5">

          {canUseCallButton ? (
            <>
              {/* Calls block — visually grouped */}
              <div className={`flex items-center gap-1 p-0.5 ${isMd3 ? 'rounded-full bg-transparent' : 'border border-neon-cyan/20 bg-void'}`}>
                <CallHeaderButtons
                  disabled={!activeChatId || !!ctxError}
                  peerReady={peerReady}
                  onCall={() => {
                    if (activeRow?.is_group) void handleGroupCall()
                    else void handleCall()
                  }}
                />
              </div>

              {/* Vertical separator */}
              <span className={`h-6 w-px shrink-0 ${isMd3 ? 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'bg-neon-cyan/20'}`} aria-hidden />
            </>
          ) : (
            <span className={`hidden md:inline text-[10px] ${isMd3 ? 'text-text-muted' : 'font-mono uppercase tracking-[0.18em] text-neon-cyan/55'}`}>
              E2E messenger
            </span>
          )}

          {/* Per-chat search — opens dock search slot on xl+, or toggles an
              inline overlay on narrower viewports. Gated on an active chat. */}
          {activeChatId ? (
            <button
              type="button"
              onClick={() => {
                toggleSearchSurface()
              }}
              aria-label={t('chatSearch.title')}
              title={t('chatSearch.title')}
              className="p13-icon-btn touch-manipulation"
            >
              <Search className="h-4 w-4" aria-hidden />
            </button>
          ) : null}

          <div
            className={`hidden h-9 sm:inline-flex items-center gap-1 px-3 text-[10px] ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                : 'border border-neon-cyan/30 bg-void font-mono uppercase tracking-[0.16em] text-neon-cyan/80'
            }`}
            title={mentionTotal > 0 ? `${t('chat.mentions')}: ${mentionTotal}` : t('chat.unreadMessages')}
          >
            <span className="opacity-80">{t('chat.inbox')}</span>
            <span
              className={`px-1.5 py-[1px] ${
                isMd3
                  ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]'
                  : 'border border-neon-cyan/50 text-neon-cyan'
              }`}
            >
              {unreadTotal > 99 ? '99+' : unreadTotal}
            </span>
            {mentionTotal > 0 ? (
              <span
                className={`px-1.5 py-[1px] ${
                  isMd3
                    ? 'rounded-full bg-[color-mix(in_srgb,var(--neon-red)_24%,transparent)] text-[var(--on-surface)]'
                    : 'border border-accent-2/50 text-accent-2'
                }`}
              >
                @{mentionTotal > 99 ? '99+' : mentionTotal}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setUnwrappedPrivateKey(null)}
            aria-label={t('chat.lockVault')}
            title={t('chat.lockVault')}
            className={`inline-flex h-9 items-center gap-1.5 px-3 text-[10px] transition-colors ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                : 'border border-neon-red/45 bg-void font-mono uppercase tracking-[0.14em] text-neon-red/85 hover:bg-neon-red/10'
            }`}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden md:inline">{t('chat.vault')}</span>
          </button>

          <div
            className={`hidden h-9 md:inline-flex items-center gap-2 px-3 ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'border border-neon-cyan/25 bg-void'
            }`}
            title={isOnline ? t('presence.online') : t('presence.offline')}
          >
            <UserAvatar
              userId={userId}
              username={user?.username ?? username}
              avatarKey={user?.avatar_key ?? null}
              size={22}
            />
            <span className={`max-w-[9rem] truncate text-[10px] ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono uppercase tracking-[0.14em] text-neon-cyan/85'}`}>
              @{user?.username ?? username}
            </span>
            <span className={`inline-flex items-center gap-1 text-[9px] ${isMd3 ? 'text-text-muted' : 'font-mono text-neon-cyan/65'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-neon-cyan' : 'bg-neon-red'}`} />
              {isOnline ? t('presence.online') : t('presence.offline')}
            </span>
          </div>

          {/* Settings — gear icon always, no text label */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t('common.openSettings')}
            title={t('common.openSettings')}
            className="p13-icon-btn touch-manipulation"
          >
            <Settings className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </header>

      {/* ─── MAIN LAYOUT ────────────────────────────────────────────────────────────────────────── */}
      <div className="chat-ultrawide-container relative flex min-h-0 min-w-0 flex-1 overflow-hidden overscroll-none">
        {mobileSidebarOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-40 touch-none bg-void/75 md:hidden"
            aria-label={t('sidebar.closeChannelList')}
            onClick={closeMobileOverlays}
          />
        ) : null}
        <div
          className={`chat-layout-sidebar fixed inset-y-0 left-0 top-0 z-50 flex min-h-0 w-screen max-w-[100vw] flex-col border-r border-border-strong bg-surface shadow-[6px_0_28px_rgba(0,0,0,0.65)] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] md:static md:z-0 md:h-full md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none pt-[var(--p13-safe-top)] md:pt-0 pb-[var(--p13-safe-bottom)] md:pb-0 ${
            mobileSidebarOpen ? 'translate-x-0 sidebar-open' : '-translate-x-full'
          } md:translate-x-0`}
          style={{ ['--p13-sb-w' as string]: `${sidebarCollapsed ? TELEGRAM_BEHAVIOR.sidebar.collapsedWidth : sidebarWidth}px` } as React.CSSProperties}
          data-collapsed={sidebarCollapsed ? 'true' : 'false'}
        >
          <div
            className={`flex h-12 shrink-0 items-center justify-between border-b px-3 md:hidden ${
              isMd3
                ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'border-neon-cyan/20'
            }`}
          >
            <span className={`text-[11px] uppercase tracking-[0.2em] ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono text-neon-cyan/85'}`}>
              {t('sidebar.channels')}
            </span>
            <button
              type="button"
              onClick={closeMobileOverlays}
              aria-label={t('common.close')}
              title={t('common.close')}
              className="p13-icon-btn touch-manipulation"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <ChatSidebar
            userId={userId}
            isAdmin={user?.role === 'admin'}
            sharedKey={sharedKey}
            isCollapsed={sidebarCollapsed}
            onPackSettingsChanged={() => setGroupDetailTick((n) => n + 1)}
            onNavigate={closeMobileOverlays}
            onOpenSettings={() => setSettingsOpen(true)}
            onLockVault={() => setUnwrappedPrivateKey(null)}
          />
        </div>
        {/* Sidebar resize handle — desktop only */}
        <div
          className={`chat-layout-divider hidden md:block shrink-0 cursor-ew-resize transition-colors touch-none z-10 ${
            sidebarCollapsed ? 'opacity-70' : ''
          }`}
          onPointerDown={handleSidebarResizeStart}
          onDoubleClick={toggleSidebarCollapsed}
          title={sidebarCollapsed ? t('sidebar.resizeExpandHint') : t('sidebar.resizeCollapseHint')}
          data-dragging={sidebarResizeActive ? 'true' : 'false'}
        />
        <div
          className={`chat-layout-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-contain ${
            mobileSidebarOpen ? 'pointer-events-none opacity-0 md:pointer-events-auto md:opacity-100' : ''
          }`}
        >
          {/* ─── DESKTOP CHAT HEADER (md+) ─────────────────────────────────────── */}
          {activeChatId ? (
            <div className={`p13-desktop-chat-header hidden md:flex shrink-0 items-center gap-3 px-4 py-2.5 border-b ${
              isMd3
                ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
                : 'border-border-strong bg-void'
            }`}
            style={{ minHeight: '56px' }}>
              {/* Peer identity / chat name */}
              <button
                type="button"
                onClick={() => {
                  if (isSelfChat) return
                  if (peerIdentity) {
                    openPeerProfile(peerIdentity.userId)
                  } else if (activeRow?.is_group) {
                    window.dispatchEvent(new Event('p13_open_group_settings'))
                  }
                }}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {isSelfChat ? (
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${isMd3 ? 'bg-[color-mix(in_srgb,var(--accent-2)_18%,transparent)] text-[var(--accent-2)]' : 'border border-accent-2/40 bg-void text-accent-2'}`}>
                    <Star className="h-5 w-5 fill-current" />
                  </div>
                ) : peerIdentity ? (
                  <div className="relative shrink-0">
                    <UserAvatar
                      userId={peerIdentity.userId}
                      username={peerIdentity.username}
                      avatarKey={null}
                      size={40}
                    />
                    {peerPresenceRow?.online ? (
                      <span className={`absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full border-2 ${isMd3 ? 'border-[var(--surface)] bg-[var(--success)]' : 'border-border-strong bg-neon-cyan shadow-[0_0_6px_rgba(34,211,238,0.7)]'}`} />
                    ) : null}
                  </div>
                ) : activeRow?.is_group ? (
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${isMd3 ? 'bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--primary)]' : 'border border-neon-cyan/50 bg-void text-neon-cyan font-mono'}`}>
                    {activeRow.name?.slice(0, 2)?.toUpperCase() || 'GR'}
                  </div>
                ) : null}

                <div className="flex min-w-0 flex-1 flex-col">
                  {isSelfChat ? (
                    <span className={`truncate text-[14px] font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono tracking-wider text-accent-2'}`}>
                      {t('sidebar.savedMessages')}
                    </span>
                  ) : peerIdentity ? (
                    <>
                      <span className={`inline-flex items-center gap-1.5 truncate text-[14px] font-semibold ${
                        isMd3 ? 'text-[var(--on-surface)]' : 'text-neon-cyan font-mono'
                      }`}>
                        {peerIdentity.verified ? (
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Verified &amp; end-to-end encrypted" />
                        ) : (cryptoCtx?.mode === 'DIRECT' || cryptoCtx?.mode === 'SELF') ? (
                          <Lock className="h-3.5 w-3.5 shrink-0 text-success" aria-label="End-to-end encrypted" />
                        ) : cryptoCtx?.mode === 'PUBLIC' ? (
                          <ShieldOff className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="Not end-to-end encrypted" />
                        ) : null}
                        {peerApproved ? <UserCheck className="h-3.5 w-3.5 shrink-0 text-accent-2" /> : null}
                        <span className="truncate">
                          {isMd3 ? peerIdentity.username : `@${peerIdentity.username}`}
                        </span>
                      </span>
                      {peerPresenceRow ? (
                        <span className={`truncate text-[12px] ${isMd3 ? 'text-text-muted' : 'font-mono text-[11px] text-text-muted/70'}`}>
                          {peerPresenceRow.online ? (
                            <span className={isMd3 ? 'text-[var(--success)]' : 'text-neon-cyan/80'}>
                              {isMd3 ? 'online' : 'ONLINE'}
                            </span>
                          ) : (
                            <span>{formatLastSeen(peerPresenceRow.last_seen_at)}</span>
                          )}
                        </span>
                      ) : null}
                    </>
                  ) : activeRow ? (
                    <>
                      <span className={`inline-flex items-center gap-1.5 truncate text-[14px] font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono tracking-wider text-neon-cyan'}`}>
                        {isChannel ? (
                          <Megaphone className="h-3.5 w-3.5 shrink-0 text-neon-cyan/80" aria-label="Channel" />
                        ) : cryptoCtx?.mode === 'SECTOR' ? (
                          <Lock className="h-3.5 w-3.5 shrink-0 text-success" aria-label="End-to-end encrypted group" />
                        ) : cryptoCtx?.mode === 'PUBLIC' ? (
                          <ShieldOff className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="Not end-to-end encrypted" />
                        ) : null}
                        {activeRow.name ?? activeRow.id}
                      </span>
                      {activeRow.is_group ? (
                        <span className={`truncate text-[12px] ${isMd3 ? 'text-text-muted' : 'font-mono text-[11px] text-text-muted/70'}`}>
                          {isChannel && isChannelSubscriber ? (
                            <span className="mr-1 opacity-60">[{t('profile.readOnly')}]</span>
                          ) : null}
                          {activeRow.member_ids.length} {t('sidebar.members')}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </button>

              {/* Right: search + identity + calls */}
              <div className="flex shrink-0 items-center gap-1 max-[1180px]:gap-0.5">
                {isMd3 ? (
                  <button
                    type="button"
                    onClick={toggleSidebarCollapsed}
                    className="p13-icon-btn"
                    aria-label={sidebarCollapsed ? 'Expand chats sidebar' : 'Collapse chats sidebar'}
                    title={sidebarCollapsed ? 'Expand chats sidebar' : 'Collapse chats sidebar'}
                  >
                    <Menu className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                ) : null}
                {peerIdentity ? (
                  <button
                    type="button"
                    onClick={() => setIdentityOpen(true)}
                    className="p13-icon-btn max-[1180px]:hidden"
                    aria-label="Security info"
                    title="Security info"
                  >
                    <ShieldCheck className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={toggleSearchSurface}
                  className="p13-icon-btn"
                  aria-label={t('chatSearch.title')}
                  title={t('chatSearch.title')}
                >
                  <Search className="h-4 w-4" strokeWidth={1.5} />
                </button>
                {isMd3 && activeRow?.is_group ? (
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new Event('p13_open_group_settings'))
                      if (sidebarCollapsed) {
                        setSidebarCollapsedPersisted(false)
                      }
                    }}
                    className="p13-icon-btn max-[1180px]:hidden"
                    aria-label={t('group.packSettings')}
                    title={t('group.packSettings')}
                  >
                    <Settings className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                ) : null}
                {canUseCallButton ? (
                  <CallHeaderButtons
                    disabled={!activeChatId || !!ctxError}
                    peerReady={peerReady}
                    onCall={() => void (activeRow?.is_group ? handleGroupCall() : handleCall())}
                  />
                ) : null}
                {/* Per-chat more options */}
                {activeChatId && activeRow ? (
                  <div ref={chatMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setChatMenuOpen((v) => !v)}
                      className="p13-icon-btn"
                      aria-label="Chat options"
                      title="Chat options"
                    >
                      <MoreVertical className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                    {chatMenuOpen ? (
                      <div className={`absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded shadow-lg border ${
                        isMd3
                          ? 'bg-[var(--surface)] border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] text-[var(--on-surface)]'
                          : 'bg-void border-neon-cyan/30 font-mono text-[11px]'
                      }`}>
                        {/* Mute options */}
                        {isChatMuted(activeRow) ? (
                          <button
                            type="button"
                            onClick={() => void handleMuteChat(null)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                              isMd3
                                ? 'hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-sm'
                                : 'hover:bg-neon-cyan/10 text-neon-cyan/80 uppercase tracking-wider'
                            }`}
                          >
                            <Bell className="h-3.5 w-3.5 shrink-0" />
                            {t('chat.unmute')}
                          </button>
                        ) : (
                          <>
                            <div className={`px-3 pt-2 pb-1 text-[10px] ${isMd3 ? 'text-text-muted' : 'text-neon-cyan/40 uppercase tracking-widest'}`}>
                              {t('chat.muteFor')}
                            </div>
                            {[
                              { label: t('chat.mute1h'), hours: 1 },
                              { label: t('chat.mute8h'), hours: 8 },
                              { label: t('chat.mute24h'), hours: 24 },
                              { label: t('chat.mute7d'), hours: 168 },
                              { label: t('chat.muteForever'), forever: true },
                            ].map((opt) => (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={() => {
                                  const until = opt.forever
                                    ? 'forever'
                                    : new Date(Date.now() + opt.hours! * 3600_000).toISOString()
                                  void handleMuteChat(until)
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                                  isMd3
                                    ? 'hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-sm'
                                    : 'hover:bg-neon-cyan/10 text-neon-cyan/80 uppercase tracking-wider'
                                }`}
                              >
                                <BellOff className="h-3.5 w-3.5 shrink-0" />
                                {opt.label}
                              </button>
                            ))}
                          </>
                        )}
                        <div className={`my-1 border-t ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'border-neon-cyan/20'}`} />
                        {/* Delete chat */}
                        <button
                          type="button"
                          onClick={() => void handleDeleteChat()}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                            isMd3
                              ? 'hover:bg-[color-mix(in_srgb,var(--neon-red)_8%,transparent)] text-sm text-[var(--neon-red)]'
                              : 'hover:bg-neon-red/10 text-neon-red/80 uppercase tracking-wider'
                          }`}
                        >
                          <Trash2 className="h-3.5 w-3.5 shrink-0" />
                          {t('chat.delete')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {ctxError ? (
            <div className="shrink-0 border-b border-border-strong px-3 py-1.5 font-mono text-[11px]">
              {ctxError.includes('MISMATCH') || ctxError.includes('COMPROMISED') ? (
                <span className="text-neon-red">
                  {t('errors.tofuMismatch')}
                </span>
              ) : ctxError.includes('PEER_SIGNAL') ? (
                <span className="text-text-muted">
                  {t('errors.peerKeyMissing')}
                </span>
              ) : ctxError.includes('MISSING_SECTOR_KEY') ? (
                <span className="text-neon-cyan/70">
                  {t('errors.groupKeyPending')}
                </span>
              ) : (
                <span className="text-text-muted">{t('errors.signalLost')}</span>
              )}
            </div>
          ) : null}
          {historyDecryptBusy ? (
            <div
              className="shrink-0 border-b border-neon-cyan/25 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-neon-cyan/60"
              aria-live="polite"
            >
              Decrypting backlog…
            </div>
          ) : null}
          <BackupReminderBanner onOpenSettings={() => setSettingsOpen(true)} />
          {capabilities.push ? <PushOnboardingBanner /> : null}
          {capabilities.calls && activeChatId && activeCallBanner[activeChatId] && !isInGroupCall ? (
            <GroupCallBanner
              participantCount={activeCallBanner[activeChatId]}
              onJoin={() => void handleGroupCall()}
            />
          ) : null}
          {mediaAccessError ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-strong px-3 py-1 font-mono text-[11px] leading-snug text-text-muted">
              <span className="min-w-0 flex-1">
                <span className="mr-2 text-neon-red">[!]</span>
                {mediaAccessError === MEDIA_PERMISSION_DENIED_CODE
                  ? t('call.mediaPermissionDenied')
                  : mediaAccessError.startsWith('ICE_FETCH_') ||
                    mediaAccessError === 'ICE_NO_TURN_RELAY' ||
                    mediaAccessError === 'ICE_SERVERS_UNAVAILABLE'
                  ? t('call.connectionLost')
                  : mediaAccessError}
              </span>
              <button
                type="button"
                onClick={clearMediaAccessError}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-text-muted/70 transition-colors hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] hover:text-text-muted"
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          <ChatTerminal
            userId={userId}
            sharedKey={sharedKey}
            currentUsername={user?.username ?? username}
            activeChat={activeRow}
            directPeerUsername={peerIdentity?.username ?? null}
            senderRoles={memberRoleByUser}
            myAvatarKey={user?.avatar_key ?? null}
            peerAvatarKey={peerAvatarKey}
            cryptoCtx={cryptoCtx}
            sendText={sendText}
            sendMedia={sendMedia}
            sendAlbum={sendAlbum}
            directPeerUserId={directPeerUserId}
            composeDisabled={!activeChatId || !!ctxError || isChannelSubscriber}
            typingLabel={
              scratchers.length === 0
                ? null
                : scratchers.length === 1
                  ? scratchers[0].username
                  : scratchers.length === 2
                    ? `${scratchers[0].username}, ${scratchers[1].username}`
                    : `${scratchers[0].username} +${scratchers.length - 1}`
            }
          />
        </div>
        {/* Right dock — visible only at xl+ (see DOCK_BREAKPOINT). On smaller
            screens the `useDockStore` consumers should open modals instead. */}
        <DockPanelXlOnly />
      </div>
      <MobileBottomNav
        activeTab={mobileNavTab}
        onTabChange={handleMobileNavTabChange}
        unreadCount={unreadTotal}
      />
    </div>
  )
}

function DockPanelXlOnly() {
  const slot = useDockStore((s) => s.slot)
  if (!slot || !matchesDockViewport()) return null
  return (
    <div className="flex min-h-0 shrink-0">
      <DockPanel />
    </div>
  )
}

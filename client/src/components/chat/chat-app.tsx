'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { Menu, ShieldCheck, Star, Settings, Search, UserCheck, Lock, X } from 'lucide-react'
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
  type ChatMemberRole,
} from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { canonicalUserId } from '@/lib/user-id'
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'
import { exportEcdhPublicJwkFromPrivateKey, hashPublicKeyJwk } from '@/lib/crypto'
import { resolveTrustStatus } from '@/lib/trust-store'
import { useChats } from '@/hooks/use-chats'
import { usePresenceSync } from '@/hooks/use-presence-sync'
import { useGroupKeyDistribution } from '@/hooks/use-group-key-distribution'
import { useWebRTC } from '@/hooks/use-webrtc'
import { NoLocalVault } from '@/components/chat/no-local-vault'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { DockPanel } from '@/components/chat/dock-panel'
import { useDockStore, matchesDockViewport } from '@/store/dockStore'
import { ChatSearchPanel } from '@/components/chat/chat-search-panel'
import { scrollToMessage } from '@/lib/chat-scroll'
import { OfflineBanner } from '@/components/offline-banner'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'
import { IdentityModal } from '@/components/chat/identity-modal'
import { UserProfileModal } from '@/components/chat/user-profile-modal'
import { PwaInstallBanner } from '@/components/pwa-install-banner'
import { PushOnboardingBanner } from '@/components/push-onboarding-banner'
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
  const [myEcdhPublicKeyJwk, setMyEcdhPublicKeyJwk] = useState<string | null>(null)
  useEffect(() => {
    if (!unwrappedPrivateKey) { setMyEcdhPublicKeyJwk(null); return }
    void exportEcdhPublicJwkFromPrivateKey(unwrappedPrivateKey)
      .then(setMyEcdhPublicKeyJwk)
      .catch(() => setMyEcdhPublicKeyJwk(null))
  }, [unwrappedPrivateKey])
  const [showGuide, setShowGuide] = useState(() => {
    if (typeof window === 'undefined') return false
    return !localStorage.getItem(`p13:onboarded:${userId}`)
  })
  useAutoLock()
  useMobileViewport()
  useAppBadge(userId)
  const vaultState = useCryptoVault(userId, user?.username ?? username)
  const { chats, reload } = useChats(userId)
  usePresenceSync(userId, chats)
  const [memberRoleByUser, setMemberRoleByUser] = useState<
    Record<string, ChatMemberRole>
  >({})
  const [groupDetailTick, setGroupDetailTick] = useState(0)
  const [peerAvatarKey, setPeerAvatarKey] = useState<string | null>(null)
  const [peerApproved, setPeerApproved] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [headerProfileOpen, setHeaderProfileOpen] = useState(false)
  const [md3HeaderCondensed, setMd3HeaderCondensed] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  const [sidebarWidth, setSidebarWidth] = useState(344)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  useLayoutEffect(() => {
    const saved = localStorage.getItem('p13_sidebar_width')
    if (!saved) return
    const n = Number(saved)
    if (Number.isFinite(n) && n >= 240 && n <= 480) setSidebarWidth(n)
  }, [])

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    sidebarDragRef.current = { startX, startWidth }
    const onMove = (mv: MouseEvent) => {
      const delta = mv.clientX - startX
      const next = Math.min(480, Math.max(240, startWidth + delta))
      setSidebarWidth(next)
    }
    const onUp = (up: MouseEvent) => {
      const delta = up.clientX - startX
      const final = Math.min(480, Math.max(240, startWidth + delta))
      localStorage.setItem('p13_sidebar_width', String(final))
      sidebarDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

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
    toggleVideo,
    switchCamera,
    isScreenSharing,
    toggleScreenShare,
    setQuality,
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
    setMobileSidebarOpen(false)
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
    if (!isMd3) {
      setMd3HeaderCondensed(false)
      return
    }
    const onScrollCapture = (ev: Event) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
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
      options?: { fileName?: string; fileType?: string; kind?: import('@/lib/attachment-envelope').AttachmentKind },
    ) => {
      await rawSendMedia(blob, mediaType, {
        label: options?.fileName,
        mime: options?.fileType,
        caption: caption?.trim() || undefined,
        ...(options?.kind ? { kind: options.kind } : {}),
      })
    },
    [rawSendMedia],
  )

  const sendAlbum = useCallback(
    async (
      items: Array<{
        blob: Blob
        segmentClass: 'audio' | 'video' | 'image' | 'file'
        options?: { label?: string; mime?: string; kind?: import('@/lib/attachment-envelope').AttachmentKind }
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

  const activeRow = chats.find((c) => c.id === activeChatId) ?? null
  const isSelfChat = activeRow != null && isSavedMessagesChat(activeRow, userId)
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
  const canShowCallControls =
    !!activeChatId && !!activeRow && !activeRow.is_group && !isSelfChat
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

  async function handleVoiceCall() {
    if (!activeChatId) return
    const peers = await fetchPeerIdsForChat(activeChatId, userId)
    if (peers.length === 0) return
    await initiateCall(peers, false, activeChatId)
  }

  async function handleVideoCall() {
    if (!activeChatId) return
    const peers = await fetchPeerIdsForChat(activeChatId, userId)
    if (peers.length === 0) return
    await initiateCall(peers, true, activeChatId)
  }

  async function handleGroupVoiceCall() {
    if (!activeChatId) return
    await startGroupCall(activeChatId, false)
  }

  async function handleGroupVideoCall() {
    if (!activeChatId) return
    await startGroupCall(activeChatId, true)
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
    <div className="chat-safe-shell flex h-[100dvh] max-h-[100dvh] min-h-0 flex-col overflow-hidden bg-void supports-[height:100dvh]:h-[100dvh]">
      <InviteChatLinkEffect userId={userId} />
      <IncomingCallModal
        onAccept={() => void acceptIncomingCall()}
        onReject={rejectIncomingCall}
      />
      <ActiveCallOverlay
        onEndCall={endCall}
        onToggleMute={toggleMuteMic}
        onToggleCamera={toggleCamera}
        onToggleVideo={toggleVideo}
        onSwitchCamera={() => void switchCamera()}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={toggleScreenShare}
        onSetQuality={setQuality}
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

      {showGuide ? (
        <StartGuide
          onComplete={() => {
            localStorage.setItem(`p13:onboarded:${userId}`, '1')
            setShowGuide(false)
          }}
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
          className="p13-search-overlay fixed inset-0 z-[120] flex flex-col bg-void/95 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-sm xl:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t('chatSearch.title')}
        >
          <ChatSearchPanel
            onClose={() => setMobileSearchOpen(false)}
            onJumpToMessage={(id) => {
              setMobileSearchOpen(false)
              scrollToMessage(id)
            }}
          />
        </div>
      ) : null}

      {/* ─── HEADER ────────────────────────────────────────────────────────────────────────── */}
      <header className={`p13-header chat-header-compact flex shrink-0 items-center gap-2 px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:hidden ${isMd3 ? `md3-top-appbar ${md3HeaderCondensed ? 'md3-top-appbar--condensed' : ''}` : ''}`}>

        {/* Burger — mobile only */}
        <button
          type="button"
          className="p13-icon-btn touch-manipulation md:hidden"
          aria-label={t('call.openChannels')}
          onClick={() => setMobileSidebarOpen(true)}
        >
          <Menu className="h-5 w-5" strokeWidth={1.5} aria-hidden />
        </button>

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
                  if (matchesDockViewport() && peerIdentity) {
                    useDockStore.getState().openProfile(peerIdentity.userId)
                  } else {
                    setHeaderProfileOpen(true)
                  }
                }}
                className={`touch-manipulation inline-flex h-9 min-w-0 items-center gap-1.5 px-3 text-[11px] font-bold transition-colors ${
                  isMd3
                    ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                    : 'border border-neon-cyan/40 bg-void tracking-wider text-neon-cyan hover:border-neon-red hover:text-neon-red'
                }`}
              >
                {peerIdentity.verified ? (
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-neon-cyan" />
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
                      <span className="text-neon-cyan/75">online</span>
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
                online
              </span>
            </div>
          )}
        </div>

        {/* RIGHT: calls block + separator + settings icon */}
        <div className="flex shrink-0 items-center gap-1.5">

          {canShowCallControls ? (
            <>
              {/* Calls block — visually grouped */}
              <div className={`flex items-center gap-1 p-0.5 ${isMd3 ? 'rounded-full bg-transparent' : 'border border-neon-cyan/20 bg-void'}`}>
                <CallHeaderButtons
                  disabled={!activeChatId || !!ctxError}
                  peerReady={peerReady}
                  onVoiceCall={() => {
                    if (activeRow?.is_group) void handleGroupVoiceCall()
                    else void handleVoiceCall()
                  }}
                  onVideoCall={() => {
                    if (activeRow?.is_group) void handleGroupVideoCall()
                    else void handleVideoCall()
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
                if (!activeChatId) return
                if (matchesDockViewport()) {
                  useDockStore.getState().openSearch(activeChatId, (id) => {
                    scrollToMessage(id)
                  })
                } else {
                  setMobileSearchOpen(true)
                }
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
            title={mentionTotal > 0 ? `Mentions: ${mentionTotal}` : 'Unread messages'}
          >
            <span className="opacity-80">Inbox</span>
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
            aria-label="Lock vault"
            title="Lock vault"
            className={`inline-flex h-9 items-center gap-1.5 px-3 text-[10px] transition-colors ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                : 'border border-neon-red/45 bg-void font-mono uppercase tracking-[0.14em] text-neon-red/85 hover:bg-neon-red/10'
            }`}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden md:inline">Vault</span>
          </button>

          <div
            className={`hidden h-9 md:inline-flex items-center gap-2 px-3 ${
              isMd3
                ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'border border-neon-cyan/25 bg-void'
            }`}
            title={isOnline ? 'Online' : 'Offline'}
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
              {isOnline ? 'online' : 'offline'}
            </span>
          </div>

          {/* Settings — gear icon always, no text label */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="CFG"
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
            aria-label="Close channel list"
            onClick={() => setMobileSidebarOpen(false)}
          />
        ) : null}
        <div
          className={`chat-layout-sidebar fixed inset-y-0 left-0 top-0 z-50 flex h-[100dvh] max-h-[100dvh] w-screen max-w-[100vw] flex-col border-r border-border-strong bg-surface shadow-[6px_0_28px_rgba(0,0,0,0.65)] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] md:static md:z-0 md:h-[100dvh] md:max-h-[100dvh] md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none pt-[env(safe-area-inset-top,0px)] md:pt-0 pb-[env(safe-area-inset-bottom,0px)] md:pb-0 ${
            mobileSidebarOpen ? 'translate-x-0 sidebar-open' : '-translate-x-full'
          } md:translate-x-0`}
          style={{ ['--sb-w' as string]: `${sidebarWidth}px` } as React.CSSProperties}
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
              onClick={() => setMobileSidebarOpen(false)}
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
            onPackSettingsChanged={() => setGroupDetailTick((n) => n + 1)}
            onNavigate={() => setMobileSidebarOpen(false)}
            onOpenSettings={() => setSettingsOpen(true)}
            onLockVault={() => setUnwrappedPrivateKey(null)}
          />
        </div>
        {/* Sidebar resize handle — desktop only */}
        <div
          className="chat-layout-divider hidden md:block w-2 shrink-0 cursor-ew-resize transition-colors touch-none z-10"
          onMouseDown={handleSidebarResizeStart}
          title="Drag to resize sidebar"
        />
        <div
          className={`chat-layout-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-contain ${
            mobileSidebarOpen ? 'pointer-events-none opacity-0 md:pointer-events-auto md:opacity-100' : ''
          }`}
        >
          {/* ─── DESKTOP CHAT HEADER (md+) ─────────────────────────────────────── */}
          {activeChatId ? (
            <div className={`p13-desktop-chat-header hidden md:flex shrink-0 items-center gap-2 px-4 py-2.5 border-b ${
              isMd3
                ? 'border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)]'
                : 'border-border-strong bg-void'
            }`}>
              {/* Peer identity / chat name */}
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {isSelfChat ? (
                  <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono tracking-wider text-accent-2'}`}>
                    <Star className="h-4 w-4 fill-accent-2 shrink-0" />
                    <span>{t('sidebar.savedMessages')}</span>
                  </div>
                ) : peerIdentity ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (matchesDockViewport()) {
                          useDockStore.getState().openProfile(peerIdentity.userId)
                        } else {
                          setHeaderProfileOpen(true)
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 text-[13px] font-semibold transition-colors ${
                        isMd3
                          ? 'text-[var(--on-surface)] hover:text-[var(--primary)]'
                          : 'text-neon-cyan hover:text-neon-red font-mono'
                      }`}
                    >
                      {peerIdentity.verified ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-neon-cyan" /> : null}
                      {peerApproved ? <UserCheck className="h-3.5 w-3.5 shrink-0 text-accent-2" /> : null}
                      <span className="truncate max-w-xs">
                        {isMd3 ? peerIdentity.username : `@${peerIdentity.username}`}
                      </span>
                    </button>
                    {peerPresenceRow ? (
                      <span className={`flex items-center gap-1.5 text-[11px] ${isMd3 ? 'text-text-muted' : 'font-mono text-[10px]'}`}>
                        {peerPresenceRow.online ? (
                          <>
                            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neon-cyan/70 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                            <span className={isMd3 ? 'text-neon-cyan/80' : 'text-neon-cyan/75'}>
                              {isMd3 ? 'online' : 'ONLINE'}
                            </span>
                          </>
                        ) : (
                          <span className="text-text-muted/80 whitespace-nowrap text-[10px]">
                            {formatLastSeen(peerPresenceRow.last_seen_at)}
                          </span>
                        )}
                      </span>
                    ) : null}
                  </>
                ) : activeRow ? (
                  <span className={`truncate text-[13px] font-semibold ${isMd3 ? 'text-[var(--on-surface)]' : 'font-mono tracking-wider text-neon-cyan'}`}>
                    {activeRow.name ?? activeRow.id}
                  </span>
                ) : null}
              </div>

              {/* Right: search + identity + calls */}
              <div className="flex shrink-0 items-center gap-1">
                {peerIdentity ? (
                  <button
                    type="button"
                    onClick={() => setIdentityOpen(true)}
                    className="p13-icon-btn"
                    aria-label="Security info"
                    title="Security info"
                  >
                    <ShieldCheck className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (!activeChatId) return
                    if (matchesDockViewport()) {
                      useDockStore.getState().openSearch(activeChatId, (id) => scrollToMessage(id))
                    } else {
                      setMobileSearchOpen(true)
                    }
                  }}
                  className="p13-icon-btn"
                  aria-label={t('chatSearch.title')}
                  title={t('chatSearch.title')}
                >
                  <Search className="h-4 w-4" strokeWidth={1.5} />
                </button>
                {canShowCallControls ? (
                  <CallHeaderButtons
                    disabled={!activeChatId || !!ctxError}
                    peerReady={peerReady}
                    onVoiceCall={() => void (activeRow?.is_group ? handleGroupVoiceCall() : handleVoiceCall())}
                    onVideoCall={() => void handleVideoCall()}
                  />
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
          <PushOnboardingBanner />
          {activeChatId && activeCallBanner[activeChatId] && !isInGroupCall ? (
            <GroupCallBanner
              participantCount={activeCallBanner[activeChatId]}
              onJoinVoice={() => void handleGroupVoiceCall()}
              onJoinVideo={() => void handleGroupVideoCall()}
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
                className="shrink-0 font-mono text-[10px] text-text-muted/70 hover:text-text-muted"
                aria-label="Dismiss"
              >
                [X]
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
            composeDisabled={!activeChatId || !!ctxError}
            typingLabel={scratchers.length > 0 ? scratchers[0].username : null}
          />
        </div>
        {/* Right dock — visible only at xl+ (see DOCK_BREAKPOINT). On smaller
            screens the `useDockStore` consumers should open modals instead. */}
        <DockPanelXlOnly />
      </div>
    </div>
  )
}

function DockPanelXlOnly() {
  const slot = useDockStore((s) => s.slot)
  if (!slot) return null
  return (
    <div className="hidden xl:flex xl:min-h-0 xl:shrink-0">
      <DockPanel />
    </div>
  )
}

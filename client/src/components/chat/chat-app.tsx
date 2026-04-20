'use client'

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { Menu, ShieldCheck, Star, Settings, Search } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { getFmSocket } from '@/lib/api/socket'
import { runPostLoginVaultSync } from '@/lib/vault-sync'
import { useChatStore } from '@/store/chatStore'
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
  const setUserId = useChatStore((s) => s.setUserId)
  const setSelfUsername = useChatStore((s) => s.setSelfUsername)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const historyDecryptBusy = useChatStore((s) => s.historyDecryptBusy)
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
  useNotificationOpen()
  useAppBadge(userId)
  const vaultState = useCryptoVault(userId, user?.username ?? username)
  const { chats, reload } = useChats(userId)
  usePresenceSync(userId, chats)
  const [memberRoleByUser, setMemberRoleByUser] = useState<
    Record<string, ChatMemberRole>
  >({})
  const [groupDetailTick, setGroupDetailTick] = useState(0)
  const [peerAvatarKey, setPeerAvatarKey] = useState<string | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [headerProfileOpen, setHeaderProfileOpen] = useState(false)

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
    if (!activeChatId || !userId) {
      setPeerIdentity(null)
      return
    }
    const active = chats.find((c) => c.id === activeChatId)
    if (!active || active.is_group) {
      setPeerIdentity(null)
      return
    }
    const peerId = active.member_ids.find(
      (id) => canonicalUserId(id) !== canonicalUserId(userId)
    )
    if (!peerId) {
      setPeerIdentity(null)
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
      } catch {
        if (!cancelled) setPeerIdentity(null)
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
  useMessages(cryptoCtx, emitPhantomSignal)
  const directPeerUserId = peerIdentity?.userId ?? null
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
  const typingUsers = useChatStore((s) => s.typingUsers)
  const peerPresence = useChatStore((s) => s.peerPresence)

  const directPeerIdForPresence =
    activeRow && !activeRow.is_group
      ? activeRow.member_ids.find(
          (id) => canonicalUserId(id) !== canonicalUserId(userId)
        ) ?? null
      : null
  const peerPresenceRow = directPeerIdForPresence
    ? peerPresence[directPeerIdForPresence]
    : undefined

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
    <div className="chat-safe-shell safe-all flex h-[100dvh] max-h-[100dvh] min-h-0 flex-col overflow-hidden bg-void supports-[height:100dvh]:h-[100dvh]">
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
          onClose={() => setIdentityOpen(false)}
          onTrustChanged={(verified) =>
            setPeerIdentity((prev) =>
              prev ? { ...prev, verified } : prev
            )
          }
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
          className="fixed inset-0 z-[120] flex flex-col bg-void/95 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-sm xl:hidden"
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
      <header className="p13-header chat-header-compact flex shrink-0 items-center gap-2 px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">

        {/* Burger — mobile only */}
        <button
          type="button"
          className="p13-icon-btn touch-manipulation md:hidden"
          aria-label={t('call.openChannels')}
          onClick={() => setMobileSidebarOpen(true)}
        >
          <Menu className="h-5 w-5" strokeWidth={1.5} aria-hidden />
        </button>

        {/* Desktop: app title (hidden on mobile) */}
        <span className="hidden md:block shrink-0 text-[10px] uppercase tracking-[0.35em] text-neon-cyan/60 whitespace-nowrap">
          ONETOTHREE :: E2E :: @{user?.username ?? username}
        </span>

        {/* CENTER: peer nick — always visible, takes remaining space */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {isSelfChat ? (
            <div className="flex min-w-0 items-center gap-1.5 border border-accent-2/40 bg-void px-2 py-1 text-[10px] tracking-[0.2em] text-accent-2">
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
                className="touch-manipulation inline-flex min-w-0 items-center gap-1.5 border border-neon-cyan/40 bg-void px-2 py-1 text-[11px] font-bold tracking-wider text-neon-cyan hover:border-neon-red hover:text-neon-red transition-colors"
              >
                {peerIdentity.verified ? (
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-neon-cyan" />
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
            /* No active chat — show app title */
            <span className="text-[10px] uppercase tracking-[0.3em] text-neon-cyan/50 truncate">
              ONETOTHREE
            </span>
          )}
        </div>

        {/* RIGHT: calls block + separator + settings icon */}
        <div className="flex shrink-0 items-center gap-1.5">

          {/* Calls block — visually grouped */}
          <div className="flex items-center gap-1 border border-neon-cyan/20 bg-void p-0.5">
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
          <span className="h-6 w-px shrink-0 bg-neon-cyan/20" aria-hidden />

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
          className={`chat-layout-sidebar fixed inset-y-0 left-0 z-50 flex h-full max-h-[100dvh] w-[min(20rem,92vw)] flex-col border-r border-border-strong bg-surface shadow-[6px_0_28px_rgba(0,0,0,0.65)] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] md:static md:z-0 md:h-auto md:max-h-none md:translate-x-0 md:shadow-none pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] ${
            mobileSidebarOpen ? 'translate-x-0 sidebar-open' : '-translate-x-full'
          } md:translate-x-0`}
        >
          <ChatSidebar
            userId={userId}
            isAdmin={user?.role === 'admin'}
            sharedKey={sharedKey}
            onPackSettingsChanged={() => setGroupDetailTick((n) => n + 1)}
            onNavigate={() => setMobileSidebarOpen(false)}
          />
        </div>
        <div className="chat-layout-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-contain">
          {ctxError ? (
            <div className="shrink-0 border-b border-border-strong px-3 py-1 font-mono text-xs text-text-muted">
              {t('errors.signalLost')}
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

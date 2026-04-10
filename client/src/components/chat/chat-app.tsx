'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { useChatStore } from '@/store/chatStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useCryptoVault } from '@/hooks/use-crypto-vault'
import { useSendMessage } from '@/hooks/use-send-message'
import { useMessages } from '@/hooks/use-messages'
import { useChatAesKey } from '@/hooks/use-chat-aes-key'
import { fetchPeerIdsForChat } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { canonicalUserId } from '@/lib/user-id'
import { hashPublicKeyJwk } from '@/lib/crypto'
import { resolveTrustStatus } from '@/lib/trust-store'
import { useChats } from '@/hooks/use-chats'
import { useWebRTC } from '@/hooks/use-webrtc'
import { NoLocalVault } from '@/components/chat/no-local-vault'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { ChatMediaControls } from '@/components/chat/chat-media-controls'
import { ChatInput } from '@/components/chat/chat-input'
import { LogoutButton } from '@/components/logout-button'
import { OfflineBanner } from '@/components/offline-banner'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'
import { IdentityModal } from '@/components/chat/identity-modal'
import { LocaleToggle } from '@/components/locale-toggle'
import { InviteChatLinkEffect } from '@/components/chat/invite-chat-link-effect'

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

export function ChatApp({
  userId,
  username,
}: {
  userId: string
  username: string
}) {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const setUserId = useChatStore((s) => s.setUserId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const [peerIdentity, setPeerIdentity] = useState<{
    userId: string
    username: string
    ecdhPublicKeyJwk: string
    verified: boolean
  } | null>(null)
  const [showGuide, setShowGuide] = useState(() => {
    if (typeof window === 'undefined') return false
    return !localStorage.getItem(`p13:onboarded:${userId}`)
  })
  const vaultState = useCryptoVault(userId, user?.username ?? username)
  const { chats } = useChats(userId)

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
  } = useWebRTC(userId)

  useLayoutEffect(() => {
    setUserId(userId)
  }, [userId, setUserId])

  useEffect(() => {
    const chat = searchParams.get('chat')
    if (chat) setActiveChatId(chat)
  }, [searchParams, setActiveChatId])

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
    return () => {
      cancelled = true
    }
  }, [activeChatId, chats, userId])

  const { cryptoCtx, ctxError } = useChatCryptoContext()
  const sharedKey = useChatAesKey(cryptoCtx)
  useMessages(cryptoCtx)
  const { sendText } = useSendMessage(cryptoCtx)

  async function handleVoiceCall() {
    if (!activeChatId) return
    const peers = await fetchPeerIdsForChat(activeChatId, userId)
    if (peers.length === 0) return
    await initiateCall(peers, false)
  }

  async function handleVideoCall() {
    if (!activeChatId) return
    const peers = await fetchPeerIdsForChat(activeChatId, userId)
    if (peers.length === 0) return
    await initiateCall(peers, true)
  }

  if (vaultState === 'loading') {
    return <div className="min-h-screen bg-black" aria-hidden />
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
    <div className="chat-safe-shell flex h-dvh flex-col bg-black supports-[height:100dvh]:h-dvh">
      <InviteChatLinkEffect userId={userId} />
      <IncomingCallModal
        onAccept={() => void acceptIncomingCall()}
        onReject={rejectIncomingCall}
      />
      <ActiveCallOverlay
        onEndCall={endCall}
        onToggleMute={toggleMuteMic}
        onToggleCamera={toggleCamera}
      />

      {showGuide ? (
        <StartGuide
          onComplete={() => {
            localStorage.setItem(`p13:onboarded:${userId}`, '1')
            setShowGuide(false)
          }}
        />
      ) : null}
      <OfflineBanner />
      {settingsOpen ? (
        <SettingsModal
          userId={userId}
          username={username}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {identityOpen && peerIdentity ? (
        <IdentityModal
          peerUserId={peerIdentity.userId}
          peerUsername={peerIdentity.username}
          peerEcdhPublicKeyJwk={peerIdentity.ecdhPublicKeyJwk}
          onClose={() => setIdentityOpen(false)}
          onTrustChanged={(verified) =>
            setPeerIdentity((prev) =>
              prev ? { ...prev, verified } : prev
            )
          }
        />
      ) : null}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neon-cyan/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <span className="shrink-0 truncate">
            PROJECT_13 :: E2E :: @{user?.username ?? username}
          </span>
          {peerIdentity ? (
            <button
              type="button"
              onClick={() => setIdentityOpen(true)}
              className="inline-flex min-w-[120px] items-center gap-1 border border-neon-cyan/40 bg-black px-2 py-1 text-[10px] tracking-[0.2em] text-neon-cyan hover:border-neon-red hover:text-neon-red"
            >
              {peerIdentity.verified ? (
                <ShieldCheck className="h-3.5 w-3.5 text-neon-cyan" />
              ) : null}
              <span className="truncate">{peerIdentity.username}</span>
            </button>
          ) : null}
          <CallHeaderButtons
            disabled={!activeChatId || !!ctxError}
            peerReady={peerReady}
            onVoiceCall={() => void handleVoiceCall()}
            onVideoCall={() => void handleVideoCall()}
          />
        </div>
        <div className="flex items-center gap-2">
          <LocaleToggle />
          {user?.role === 'admin' ? (
            <Link
              href="/admin"
              className="border border-red-900 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red"
            >
              [ WARDEN ]
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="border border-neon-cyan/60 bg-black px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
          >
            [ CFG ]
          </button>
          <LogoutButton />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <ChatSidebar userId={userId} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {ctxError ? (
            <div className="shrink-0 border-b border-neon-red px-3 py-1 font-mono text-xs text-neon-red">
              [!] {ctxError}
            </div>
          ) : null}
          {mediaAccessError ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neon-red px-3 py-1 font-mono text-[11px] leading-snug text-neon-red">
              <span>[!] {mediaAccessError}</span>
              <button
                type="button"
                onClick={clearMediaAccessError}
                className="shrink-0 font-mono text-[10px] text-red-800 hover:text-neon-red"
                aria-label="Dismiss media error"
              >
                [X]
              </button>
            </div>
          ) : null}
          <ChatTerminal
            userId={userId}
            sharedKey={sharedKey}
            currentUsername={user?.username ?? username}
            activeChat={chats.find((c) => c.id === activeChatId) ?? null}
            directPeerUsername={peerIdentity?.username ?? null}
          />
          <ChatMediaControls
            cryptoCtx={cryptoCtx}
            disabled={!activeChatId || !!ctxError}
          />
          <ChatInput
            sendText={sendText}
            disabled={!activeChatId || !!ctxError}
          />
        </div>
      </div>
    </div>
  )
}

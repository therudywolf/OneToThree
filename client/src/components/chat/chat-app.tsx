'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { useChatStore } from '@/store/chatStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useCryptoVault } from '@/hooks/use-crypto-vault'
import { useSendMessage } from '@/hooks/use-send-message'
import { useMessages } from '@/hooks/use-messages'
import { useChatAesKey } from '@/hooks/use-chat-aes-key'
import { createDirectE2EChat, fetchPeerIdsForChat } from '@/lib/api/chats'
import { useWebRTC } from '@/hooks/use-webrtc'
import { NoLocalVault } from '@/components/chat/no-local-vault'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { ChatMediaControls } from '@/components/chat/chat-media-controls'
import { ChatInput } from '@/components/chat/chat-input'
import { LogoutButton } from '@/components/logout-button'
import { OfflineBanner } from '@/components/offline-banner'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'

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
  const [showGuide, setShowGuide] = useState(() => {
    if (typeof window === 'undefined') return false
    return !localStorage.getItem(`p13:onboarded:${userId}`)
  })
  const vaultState = useCryptoVault(userId, user?.username ?? username)

  const {
    peerReady,
    initiateCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMuteMic,
    toggleCamera,
  } = useWebRTC(userId)

  useEffect(() => {
    setUserId(userId)
  }, [userId, setUserId])

  useEffect(() => {
    const chat = searchParams.get('chat')
    if (chat) setActiveChatId(chat)
  }, [searchParams, setActiveChatId])

  useEffect(() => {
    const invite = searchParams.get('invite')?.trim()
    if (!invite || invite === userId) return
    const onceKey = `p13:invite-opened:${userId}:${invite}`
    if (sessionStorage.getItem(onceKey) === '1') return
    sessionStorage.setItem(onceKey, '1')
    void createDirectE2EChat(userId, invite)
      .then((chat) => setActiveChatId(chat.id))
      .catch(() => {
        /* invalid invite or hidden/unknown user */
      })
  }, [searchParams, setActiveChatId, userId])

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
    <div className="flex h-dvh flex-col bg-black supports-[height:100dvh]:h-dvh">
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
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neon-cyan/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <span className="shrink-0">PROJECT_13 :: E2E</span>
          <CallHeaderButtons
            disabled={!activeChatId || !!ctxError}
            peerReady={peerReady}
            onVoiceCall={() => void handleVoiceCall()}
            onVideoCall={() => void handleVideoCall()}
          />
        </div>
        <div className="flex items-center gap-2">
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
          <ChatTerminal userId={userId} sharedKey={sharedKey} />
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

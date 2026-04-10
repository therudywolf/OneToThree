'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  mirrorVaultLoginToUserId,
  persistVaultBlob,
  readVaultBlob,
  readVaultBlobByLoginUsername,
} from '@/lib/vault'
import { useChatStore } from '@/store/chatStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useSendMessage } from '@/hooks/use-send-message'
import { useMessages } from '@/hooks/use-messages'
import { useChatAesKey } from '@/hooks/use-chat-aes-key'
import { fetchPeerIdsForChat } from '@/lib/api/chats'
import { useWebRTC } from '@/hooks/use-webrtc'
import { NoLocalVault } from '@/components/chat/no-local-vault'
import { VaultModal } from '@/components/chat/vault-modal'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { ChatMediaControls } from '@/components/chat/chat-media-controls'
import { ChatInput } from '@/components/chat/chat-input'
import { LogoutButton } from '@/components/logout-button'
import { OfflineBanner } from '@/components/offline-banner'
import { SettingsModal } from '@/components/settings-modal'
import { StartGuide } from '@/components/onboarding/start-guide'
import { IncomingCallModal } from '@/components/call/incoming-call-modal'
import { ActiveCallOverlay } from '@/components/call/active-call-overlay'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'

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
  const [vaultState, setVaultState] = useState<'loading' | 'ok' | 'missing'>(
    'loading'
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showGuide, setShowGuide] = useState(() => {
    if (typeof window === 'undefined') return false
    return !localStorage.getItem(`p13:onboarded:${userId}`)
  })

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
    if (readVaultBlob(userId)) {
      setVaultState('ok')
      return
    }
    const handle = user?.username ?? username
    const byLogin = readVaultBlobByLoginUsername(handle)
    if (byLogin) {
      mirrorVaultLoginToUserId(handle, userId)
      persistVaultBlob(userId, byLogin)
      setVaultState('ok')
      return
    }
    setVaultState('missing')
  }, [userId, user?.username, username])

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

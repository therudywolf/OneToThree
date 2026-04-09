'use client'

import { useEffect, useState } from 'react'
import { readVaultBlob } from '@/lib/vault'
import { useChatStore } from '@/store/chatStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useLoadChatMessages } from '@/hooks/use-load-chat-messages'
import { useChatRealtime } from '@/hooks/use-chat-realtime'
import { useSendMessage } from '@/hooks/use-send-message'
import { useChatAesKey } from '@/hooks/use-chat-aes-key'
import { fetchPeerIdsForChat, useWebRTC } from '@/hooks/use-webrtc'
import { VaultModal } from '@/components/chat/vault-modal'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { ChatMediaControls } from '@/components/chat/chat-media-controls'
import { ChatInput } from '@/components/chat/chat-input'
import { LogoutButton } from '@/components/logout-button'
import { IncomingCallModal } from '@/components/call/incoming-call-modal'
import { ActiveCallOverlay } from '@/components/call/active-call-overlay'
import { CallHeaderButtons } from '@/components/call/call-header-buttons'

export function ChatApp({
  userId,
  email,
}: {
  userId: string
  email: string
}) {
  const setUserId = useChatStore((s) => s.setUserId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [vaultMode, setVaultMode] = useState<'unlock' | 'setup' | null>(null)

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
    setVaultMode(readVaultBlob(userId) ? 'unlock' : 'setup')
  }, [userId])

  const { cryptoCtx, ctxError } = useChatCryptoContext()
  const sharedKey = useChatAesKey(cryptoCtx)
  useLoadChatMessages(cryptoCtx)
  useChatRealtime(cryptoCtx)
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

  if (vaultMode === null) {
    return <div className="min-h-screen bg-black" aria-hidden />
  }

  if (!unwrappedPrivateKey) {
    return <VaultModal userId={userId} email={email} mode={vaultMode} />
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-black">
      <IncomingCallModal
        onAccept={() => void acceptIncomingCall()}
        onReject={rejectIncomingCall}
      />
      <ActiveCallOverlay
        onEndCall={endCall}
        onToggleMute={toggleMuteMic}
        onToggleCamera={toggleCamera}
      />

      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neon-cyan/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <span className="shrink-0">FOREST_MESSENGER :: E2E</span>
          <CallHeaderButtons
            disabled={!activeChatId || !!ctxError}
            peerReady={peerReady}
            onVoiceCall={() => void handleVoiceCall()}
            onVideoCall={() => void handleVideoCall()}
          />
        </div>
        <LogoutButton />
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

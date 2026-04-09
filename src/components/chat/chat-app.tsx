'use client'

import { useEffect, useState } from 'react'
import { readVaultBlob } from '@/lib/vault'
import { useChatStore } from '@/store/chatStore'
import { useChatCryptoContext } from '@/hooks/use-chat-crypto-context'
import { useLoadChatMessages } from '@/hooks/use-load-chat-messages'
import { useChatRealtime } from '@/hooks/use-chat-realtime'
import { useSendMessage } from '@/hooks/use-send-message'
import { VaultModal } from '@/components/chat/vault-modal'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatTerminal } from '@/components/chat/chat-terminal'
import { ChatInput } from '@/components/chat/chat-input'
import { LogoutButton } from '@/components/logout-button'

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

  useEffect(() => {
    setUserId(userId)
  }, [userId, setUserId])

  useEffect(() => {
    setVaultMode(readVaultBlob(userId) ? 'unlock' : 'setup')
  }, [userId])

  const { cryptoCtx, ctxError } = useChatCryptoContext()
  useLoadChatMessages(cryptoCtx)
  useChatRealtime(cryptoCtx)
  const { sendText } = useSendMessage(cryptoCtx)

  if (vaultMode === null) {
    return <div className="min-h-screen bg-black" aria-hidden />
  }

  if (!unwrappedPrivateKey) {
    return <VaultModal userId={userId} email={email} mode={vaultMode} />
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-black">
      <header className="flex shrink-0 items-center justify-between border-b border-neon-cyan/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
        <span>FOREST_MESSENGER :: E2E</span>
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
          <ChatTerminal userId={userId} />
          <ChatInput
            sendText={sendText}
            disabled={!activeChatId || !!ctxError}
          />
        </div>
      </div>
    </div>
  )
}

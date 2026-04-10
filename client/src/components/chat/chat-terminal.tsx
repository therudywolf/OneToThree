'use client'

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chatStore'
import { MediaMessage } from '@/components/chat/media-message'

export function ChatTerminal({
  userId,
  sharedKey,
}: {
  userId: string
  sharedKey: CryptoKey | null
}) {
  const messages = useChatStore((s) => s.messages)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [messages])

  if (!activeChatId) {
    return (
      <div className="crt-terminal-vignette flex flex-1 items-center justify-center bg-black font-mono text-xs text-red-800">
        SELECT_OR_OPEN_CHANNEL
      </div>
    )
  }

  return (
    <div className="crt-terminal-vignette relative min-h-0 flex-1 overflow-hidden bg-black">
      <div
        ref={ref}
        className="h-full overflow-y-auto px-4 py-3 font-mono text-sm text-neon-red"
      >
        {messages.length === 0 ? (
          <p className="text-xs text-red-800">NO_PACKETS</p>
        ) : null}
        {messages.map((m) => (
          <div
            key={m.id}
            className="mb-3 border-l-2 border-neon-cyan/40 pl-2"
          >
            <div className="text-[10px] text-neon-cyan/90">
              [{m.sender_id === userId ? 'OUT' : 'IN'}]{' '}
              <span className="text-red-800">
                {new Date(m.created_at).toLocaleString()}
              </span>
            </div>
            {m.plaintext ? (
              <div className="whitespace-pre-wrap break-words">{m.plaintext}</div>
            ) : null}
            {m.media_path && m.media_iv && m.media_type ? (
              <MediaMessage message={m} sharedKey={sharedKey} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

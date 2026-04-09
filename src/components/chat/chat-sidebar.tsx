'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useChatStore } from '@/store/chatStore'
import { NotificationToggle } from '@/components/notification-toggle'

type ChatRow = { id: string; is_group: boolean }

export function ChatSidebar({ userId }: { userId: string }) {
  const supabase = createClient()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const [chats, setChats] = useState<ChatRow[]>([])
  const [peerInput, setPeerInput] = useState('')
  const [creating, setCreating] = useState(false)

  const loadChats = useCallback(async () => {
    const { data, error } = await supabase
      .from('chat_members')
      .select('chat_id, chats ( id, is_group )')
      .eq('user_id', userId)

    if (error || !data) {
      setChats([])
      return
    }

    const rows: ChatRow[] = []
    for (const row of data) {
      const rel = row.chats as ChatRow | ChatRow[] | null
      const c = Array.isArray(rel) ? rel[0] : rel
      if (c?.id) {
        rows.push({ id: c.id, is_group: c.is_group })
      }
    }
    setChats(rows)
  }, [supabase, userId])

  useEffect(() => {
    void loadChats()
  }, [loadChats])

  async function openDirect() {
    const pid = peerInput.trim()
    if (!pid || pid === userId) return
    setCreating(true)
    try {
      const { data: chat, error } = await supabase
        .from('chats')
        .insert({ is_group: false })
        .select('id')
        .single()
      if (error || !chat) throw error

      const a = await supabase.from('chat_members').insert({
        chat_id: chat.id,
        user_id: userId,
      })
      if (a.error) throw a.error

      const b = await supabase.from('chat_members').insert({
        chat_id: chat.id,
        user_id: pid,
      })
      if (b.error) throw b.error

      setPeerInput('')
      setChats((s) => [...s, { id: chat.id, is_group: false }])
      setActiveChatId(chat.id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-neon-cyan/40 bg-black">
      <NotificationToggle userId={userId} />
      <div className="border-b border-neon-cyan/40 p-3 text-[10px] uppercase tracking-[0.3em] text-neon-cyan">
        :: CHANNELS
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto">
        {chats.length === 0 ? (
          <p className="px-3 py-2 font-mono text-[10px] text-red-800">
            NO_ACTIVE_ROUTES
          </p>
        ) : null}
        {chats.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveChatId(c.id)}
            className={`w-full rounded-none border-b border-neon-cyan/20 px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan ${
              activeChatId === c.id
                ? 'bg-neon-cyan/15 text-neon-cyan'
                : 'text-neon-red'
            }`}
          >
            {c.is_group ? '[GRP]' : '[DIR]'} {c.id.slice(0, 8)}…
          </button>
        ))}
      </nav>
      <div className="border-t border-neon-cyan/40 p-2">
        <p className="mb-1 text-[10px] uppercase tracking-widest text-neon-cyan">
          :: open_direct
        </p>
        <input
          className="terminal-input mb-2 text-xs"
          placeholder="peer user uuid"
          value={peerInput}
          onChange={(e) => setPeerInput(e.target.value)}
        />
        <button
          type="button"
          onClick={() => void openDirect()}
          disabled={creating}
          className="w-full rounded-none border border-neon-red bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
        >
          [ OPEN ]
        </button>
      </div>
    </aside>
  )
}

'use client'

import { useState } from 'react'
import { useChatStore } from '@/store/chatStore'
import { NotificationToggle } from '@/components/notification-toggle'
import { createDirectE2EChat, leaveChat, deleteChat } from '@/lib/api/chats'
import { useChats } from '@/hooks/use-chats'
import { CreateGroupModal } from '@/components/chat/create-group-modal'
import { searchUsers } from '@/lib/api/users'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

export function ChatSidebar({ userId }: { userId: string }) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const { chats, reload } = useChats(userId)
  const [peerInput, setPeerInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function openDirect() {
    const raw = peerInput.trim()
    if (!raw) return
    setCreating(true)
    setCreateErr(null)
    try {
      let pid = raw
      if (!isUuid(raw)) {
        const candidates = await searchUsers(raw)
        const exact = candidates.find(
          (u) => u.username.toLowerCase() === raw.toLowerCase()
        )
        if (!exact) {
          throw new Error('USER_NOT_FOUND_OR_HIDDEN')
        }
        pid = exact.id
      }
      if (pid === userId) {
        throw new Error('CANNOT_OPEN_DIRECT_WITH_SELF')
      }
      const chat = await createDirectE2EChat(userId, pid)
      setActiveChatId(chat.id)
      setPeerInput('')
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'CREATE_FAILED')
    } finally {
      setCreating(false)
    }
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-neon-cyan/40 bg-black">
      {groupModalOpen ? (
        <CreateGroupModal
          userId={userId}
          onClose={() => setGroupModalOpen(false)}
          onCreated={(id) => {
            setActiveChatId(id)
            setGroupModalOpen(false)
          }}
        />
      ) : null}
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
            {c.is_group ? '[GRP]' : '[DIR]'}{' '}
            {c.name?.trim() || `${c.id.slice(0, 8)}…`}
          </button>
        ))}
      </nav>
      {activeChatId ? (
        <div className="flex gap-1 border-t border-neon-cyan/40 px-2 pt-2">
          {chats.find((c) => c.id === activeChatId)?.is_group ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void leaveChat(activeChatId)
                  .then(() => {
                    setActiveChatId(null)
                    void reload()
                  })
                  .catch((e) => setCreateErr(e instanceof Error ? e.message : 'ERR'))
                  .finally(() => setBusy(false))
              }}
              className="flex-1 border border-red-900 bg-black py-1 font-mono text-[9px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red disabled:opacity-40"
            >
              [ LEAVE ]
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm('PURGE_CHAT_DATA?')) return
              setBusy(true)
              void deleteChat(activeChatId)
                .then(() => {
                  setActiveChatId(null)
                  void reload()
                })
                .catch((e) => setCreateErr(e instanceof Error ? e.message : 'ERR'))
                .finally(() => setBusy(false))
            }}
            className="flex-1 border border-red-900 bg-black py-1 font-mono text-[9px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red disabled:opacity-40"
          >
            [ DELETE ]
          </button>
        </div>
      ) : null}
      <div className="border-t border-neon-cyan/40 p-2">
        <button
          type="button"
          onClick={async () => {
            const origin = window.location.origin
            const link = `${origin}/?invite=${encodeURIComponent(userId)}`
            try {
              await navigator.clipboard.writeText(link)
              setCreateErr('INVITE_LINK_COPIED')
            } catch {
              setCreateErr(link)
            }
          }}
          className="mb-2 w-full rounded-none border border-neon-red/70 bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-red hover:bg-neon-red/10"
        >
          [ COPY_MY_INVITE ]
        </button>
        <button
          type="button"
          onClick={() => setGroupModalOpen(true)}
          className="mb-2 w-full rounded-none border border-neon-cyan bg-black py-1 font-mono text-xs uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
        >
          [ CREATE_GROUP_E2E ]
        </button>
        <p className="mb-1 text-[10px] uppercase tracking-widest text-neon-cyan">
          :: open_direct
        </p>
        {createErr ? (
          <p className="mb-1 font-mono text-[10px] text-neon-red">{createErr}</p>
        ) : null}
        <input
          className="terminal-input mb-2 text-xs"
          placeholder="peer uuid or username"
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

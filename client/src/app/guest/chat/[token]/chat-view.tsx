'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Minimal 1:1 temp-chat UI for the guest tab: header with the host's name and
 * the self-destruct button, message list (mine right / theirs left), composer.
 * Text only; all state comes from the parent — this component is pure view.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type { GuestChatMessage } from '@/lib/guest-chat/transport'

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function MessageBubble({ m }: { m: GuestChatMessage }) {
  return (
    <div className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
          m.mine
            ? 'rounded-br-md bg-emerald-700/80 text-emerald-50'
            : 'rounded-bl-md bg-neutral-800 text-neutral-100'
        }`}
      >
        {m.failed ? (
          <p className="italic text-neutral-400">
            Не удалось расшифровать сообщение
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
        )}
        <p
          className={`mt-0.5 text-right text-[10px] tabular-nums ${
            m.mine ? 'text-emerald-200/70' : 'text-neutral-500'
          }`}
        >
          {formatTime(m.createdAt)}
        </p>
      </div>
    </div>
  )
}

export function GuestChatView({
  hostName,
  messages,
  sending,
  notice,
  onSend,
  onLeave,
}: {
  hostName: string
  messages: GuestChatMessage[]
  sending: boolean
  /** Non-fatal transport warning shown under the header (e.g. send failed). */
  notice: string | null
  onSend: (text: string) => void
  onLeave: () => void
}) {
  const [draft, setDraft] = useState('')
  const [confirmLeave, setConfirmLeave] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const text = draft.trim()
      if (!text || sending) return
      setDraft('')
      onSend(text)
    },
    [draft, sending, onSend]
  )

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {hostName} · временный чат
          </h1>
          <p className="truncate text-[11px] text-neutral-500">
            Сквозное шифрование · чат исчезнет вместе с этой вкладкой
          </p>
        </div>
        {confirmLeave ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onLeave}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500"
            >
              Точно удалить
            </button>
            <button
              type="button"
              onClick={() => setConfirmLeave(false)}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
            >
              Отмена
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            className="shrink-0 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-900/40"
          >
            Выйти и удалить
          </button>
        )}
      </header>

      {notice ? (
        <div className="border-b border-amber-900/40 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-300">
          {notice}
        </div>
      ) : null}

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Пока сообщений нет — напишите первым
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} m={m} />)
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-neutral-800 px-3 py-3"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Сообщение…"
          maxLength={4000}
          autoFocus
          className="min-w-0 flex-1 rounded-xl border border-neutral-700 bg-neutral-900 px-3.5 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="shrink-0 rounded-xl bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Отправка…' : 'Отправить'}
        </button>
      </form>
    </div>
  )
}

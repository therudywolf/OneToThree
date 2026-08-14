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
            ? 'rounded-br-md bg-[var(--secondary-container)] text-[var(--on-secondary-container)]'
            : 'rounded-bl-md bg-surface-elevated text-text-primary'
        }`}
      >
        {m.failed ? (
          <p className="italic text-text-muted">
            Не удалось расшифровать сообщение
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
        )}
        {/* On my own bubble the only ink guaranteed readable over the tonal
            container is its own on-colour, so the timestamp inherits and
            merely dims; the peer bubble sits on a plain surface and can use
            the muted text token directly. */}
        <p
          className={`mt-0.5 text-right text-[10px] tabular-nums ${
            m.mine ? 'opacity-70' : 'text-text-muted'
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
    <div className="flex h-dvh flex-col bg-void text-text-primary">
      <header className="flex items-center justify-between gap-3 border-b border-border-strong px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {hostName} · временный чат
          </h1>
          <p className="truncate text-[11px] text-text-muted">
            Сквозное шифрование · чат исчезнет вместе с этой вкладкой
          </p>
        </div>
        {confirmLeave ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onLeave}
              className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition hover:opacity-90"
            >
              Точно удалить
            </button>
            <button
              type="button"
              onClick={() => setConfirmLeave(false)}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text-muted transition hover:bg-[var(--state-hover)]"
            >
              Отмена
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            className="shrink-0 rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-[color-mix(in_srgb,var(--danger)_26%,transparent)]"
          >
            Выйти и удалить
          </button>
        )}
      </header>

      {notice ? (
        <div className="border-b border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-4 py-1.5 text-xs text-warning">
          {notice}
        </div>
      ) : null}

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Пока сообщений нет — напишите первым
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} m={m} />)
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-border-strong px-3 py-3"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Сообщение…"
          maxLength={4000}
          autoFocus
          className="min-w-0 flex-1 rounded-xl border border-border-strong bg-surface-elevated px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-neon-cyan focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="shrink-0 rounded-xl bg-on-surface px-4 py-2.5 text-sm font-medium text-void transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Отправка…' : 'Отправить'}
        </button>
      </form>
    </div>
  )
}

'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Guest TEMP-CHAT client (mechanism B):
 *
 *   resolve token → nickname card → /guest/enter (burns the link, mints the
 *   ephemeral account) → normal challenge/verify login with the in-tab ECDSA
 *   key → 1:1 E2EE chat with the link creator over the app's per-device
 *   fan-out wire format.
 *
 * All guest state lives in sessionStorage ('ot3_guest_*'): a reload of the
 * SAME tab skips /guest/enter and goes straight to login+chat; closing the
 * tab loses the chat forever — by design.
 *
 * No zustand app stores, no vault, no IndexedDB.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { guestEnter, guestLeave, resolveGuestToken } from '@/lib/api/guest'
import {
  clearGuestSession,
  createGuestKeys,
  isGuestSessionDead,
  loginGuest,
  newGuestDeviceKey,
  readGuestSession,
  saveGuestSession,
  type GuestSessionState,
} from '@/lib/guest-chat/session'
import {
  bootstrapGuestChat,
  fetchGuestHistory,
  markGuestMessagesRead,
  pullGuestPending,
  sendGuestMessage,
  type GuestChatContext,
  type GuestChatMessage,
} from '@/lib/guest-chat/transport'
import { GuestChatSocket } from '@/lib/guest-chat/socket'
import { GuestChatView } from './chat-view'

// ─── Stages ─────────────────────────────────────────────────────────────────

type Stage =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  // Seat taken rather than link dead — a one-seat chat link that someone else
  // opened first, or lost the race at enter. Distinguishing the two stops the
  // «истекла» wording from sending people looking for a broken link.
  | { kind: 'taken' }
  | { kind: 'form' }
  | { kind: 'entering' }
  | { kind: 'chat' }
  | { kind: 'deleted' }
  | { kind: 'session-ended' }
  | { kind: 'error'; message: string }

// ─── Small UI atoms (same look as /guest/call) ──────────────────────────────

function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-void px-4 text-text-primary">
      <div className="w-full max-w-sm rounded-2xl border border-border-strong bg-surface-elevated p-6 shadow-xl">
        {children}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-text-primary"
      aria-label="Загрузка"
    />
  )
}

// ─── Page client ────────────────────────────────────────────────────────────

export function GuestChatClient({ routeToken }: { routeToken: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Static export ships only /guest/chat/_ — accept ?token= there.
  const token =
    routeToken && routeToken !== '_'
      ? routeToken
      : (searchParams.get('token') ?? '')

  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [hostName, setHostName] = useState('')
  const [nickname, setNickname] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [messages, setMessages] = useState<GuestChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const ctxRef = useRef<GuestChatContext | null>(null)
  const socketRef = useRef<GuestChatSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pullingRef = useRef(false)
  const pullAgainRef = useRef(false)
  const seenIdsRef = useRef<Set<string>>(new Set())
  const aliveRef = useRef(true)

  const teardownRealtime = useCallback(() => {
    socketRef.current?.stop()
    socketRef.current = null
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
  }, [])

  const endSession = useCallback(() => {
    teardownRealtime()
    if (aliveRef.current) setStage({ kind: 'session-ended' })
  }, [teardownRealtime])

  /** Append messages (dedupe by id, keep chronological order). */
  const appendMessages = useCallback((incoming: GuestChatMessage[]) => {
    const fresh = incoming.filter((m) => !seenIdsRef.current.has(m.id))
    if (fresh.length === 0) return
    for (const m of fresh) seenIdsRef.current.add(m.id)
    setMessages((prev) =>
      [...prev, ...fresh].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
      )
    )
    const theirsUnread = fresh.filter((m) => !m.mine && !m.failed).map((m) => m.id)
    markGuestMessagesRead(theirsUnread)
  }, [])

  /** Serialized pending pull (mirrors use-chat-realtime's re-run flag). */
  const pullPending = useCallback(async () => {
    const ctx = ctxRef.current
    if (!ctx) return
    if (pullingRef.current) {
      pullAgainRef.current = true
      return
    }
    pullingRef.current = true
    try {
      do {
        pullAgainRef.current = false
        const fresh = await pullGuestPending(ctx)
        if (!aliveRef.current) return
        appendMessages(fresh)
      } while (pullAgainRef.current)
    } catch (err) {
      if (isGuestSessionDead(err)) endSession()
    } finally {
      pullingRef.current = false
    }
  }, [appendMessages, endSession])

  /** Login (challenge/verify), bootstrap chat, load history, start realtime. */
  const openChat = useCallback(
    async (state: GuestSessionState) => {
      setStage({ kind: 'entering' })
      try {
        const { myDeviceId } = await loginGuest(state)
        const ctx = await bootstrapGuestChat(state, myDeviceId)
        if (!aliveRef.current) return
        ctxRef.current = ctx
        setHostName(state.hostName || ctx.hostUsername)

        const history = await fetchGuestHistory(ctx)
        if (!aliveRef.current) return
        seenIdsRef.current = new Set()
        setMessages([])
        appendMessages(history)

        // Drain anything queued for this device before realtime starts.
        await pullPending()

        const socket = new GuestChatSocket({
          onChatMessage: (m) => {
            if (m.message.chat_id !== ctx.chatId) return
            if (seenIdsRef.current.has(m.message.id)) return
            // Fan-out frames carry content:null — the payload arrives via the
            // pending-deliveries pull; anything else (system rows) is skipped.
            if (m.message.content == null || m.message.content === '') {
              void pullPending()
            }
          },
          onAuthLost: endSession,
        })
        socketRef.current = socket
        socket.start()

        // Safety net: WS can silently miss frames — poll on a slow interval.
        pollTimerRef.current = setInterval(() => void pullPending(), 25_000)

        // Hard guest expiry → the session screen, even with zero traffic.
        const expiresIn = Date.parse(state.expiresAt) - Date.now()
        if (Number.isFinite(expiresIn) && expiresIn > 0) {
          expiryTimerRef.current = setTimeout(endSession, expiresIn)
        }

        setStage({ kind: 'chat' })
      } catch (err) {
        if (!aliveRef.current) return
        if (isGuestSessionDead(err)) {
          setStage({ kind: 'session-ended' })
        } else {
          setStage({
            kind: 'error',
            message: 'Не удалось открыть чат. Обновите страницу и попробуйте снова.',
          })
        }
      }
    },
    [appendMessages, pullPending, endSession]
  )

  // ── Step 1: resume a saved session, otherwise resolve the token ───────────
  useEffect(() => {
    aliveRef.current = true

    const saved = readGuestSession()
    if (saved && (!token || token === saved.token)) {
      // Reload of the same tab: the link is already consumed — never re-enter.
      void openChat(saved)
      return () => {
        aliveRef.current = false
        teardownRealtime()
      }
    }

    if (!token) {
      setStage({ kind: 'invalid' })
      return () => {
        aliveRef.current = false
        teardownRealtime()
      }
    }

    void (async () => {
      try {
        const info = await resolveGuestToken(token)
        if (!aliveRef.current) return
        if (info.kind !== 'chat') {
          router.replace(`/guest/call/${encodeURIComponent(token)}`)
          return
        }
        setHostName(info.host_name)
        setStage({ kind: 'form' })
      } catch (err) {
        if (!aliveRef.current) return
        const code = err instanceof Error ? err.message : ''
        setStage({ kind: code === 'INVITE_FULL' ? 'taken' : 'invalid' })
      }
    })()

    return () => {
      aliveRef.current = false
      teardownRealtime()
    }
  }, [token, router, openChat, teardownRealtime])

  // ── Step 2: nickname card → enter → login → chat ──────────────────────────
  const submitEnter = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      const name = nickname.trim()
      if (name.length < 1 || name.length > 32) {
        setFormError('Имя должно быть от 1 до 32 символов')
        return
      }
      setBusy(true)
      setFormError(null)
      try {
        const keys = await createGuestKeys()
        const entered = await guestEnter({
          token,
          nickname: name,
          publicKeyJwk: keys.ecdsaPubJwk,
          ecdhPublicKeyJwk: keys.ecdhPubJwk,
        })
        const state: GuestSessionState = {
          token,
          username: entered.username,
          userId: entered.user_id,
          chatId: entered.chat_id,
          nickname: name,
          hostName,
          expiresAt: entered.expires_at,
          deviceKey: newGuestDeviceKey(),
          ecdsaPrivJwk: keys.ecdsaPrivJwk,
          ecdhPrivJwk: keys.ecdhPrivJwk,
        }
        saveGuestSession(state)
        await openChat(state)
      } catch (err) {
        const code = err instanceof Error ? err.message : ''
        switch (code) {
          case 'NICKNAME_TAKEN':
            setFormError('Это имя занято — выберите другое')
            break
          case 'INVALID_NICKNAME':
            setFormError('Недопустимое имя — используйте от 1 до 32 символов')
            break
          case 'GUEST_CAPACITY':
            setFormError('Сервер сейчас не принимает гостей — попробуйте позже')
            break
          case 'INVITE_NOT_FOUND':
            setStage({ kind: 'invalid' })
            break
          case 'INVITE_FULL':
            setStage({ kind: 'taken' })
            break
          default:
            setFormError('Не удалось войти — попробуйте ещё раз')
        }
      } finally {
        setBusy(false)
      }
    },
    [nickname, token, hostName, openChat]
  )

  // ── Chat actions ──────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string) => {
      const ctx = ctxRef.current
      if (!ctx) return
      setSending(true)
      setNotice(null)
      try {
        const sent = await sendGuestMessage(ctx, text)
        if (!aliveRef.current) return
        appendMessages([
          { id: sent.id, mine: true, text, createdAt: sent.createdAt },
        ])
      } catch (err) {
        if (!aliveRef.current) return
        if (isGuestSessionDead(err)) {
          endSession()
        } else {
          setNotice('Сообщение не отправлено — проверьте соединение и попробуйте ещё раз')
        }
      } finally {
        setSending(false)
      }
    },
    [appendMessages, endSession]
  )

  const handleLeave = useCallback(async () => {
    teardownRealtime()
    try {
      await guestLeave()
    } catch {
      /* the sweeper will purge an already-dead session server-side */
    }
    clearGuestSession()
    ctxRef.current = null
    setStage({ kind: 'deleted' })
  }, [teardownRealtime])

  // ── Screens ───────────────────────────────────────────────────────────────

  if (stage.kind === 'loading' || stage.kind === 'entering') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-text-muted">
            {stage.kind === 'loading'
              ? 'Проверяем приглашение…'
              : 'Входим в чат…'}
          </p>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'invalid') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          Ссылка недействительна или истекла
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          Ссылка одноразовая: если чат уже открывали или срок вышел, попросите
          пригласившего вас человека прислать новую.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'taken') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Этой ссылкой уже воспользовались</h1>
        <p className="mt-2 text-sm text-text-muted">
          Ссылка одноразовая, и чат по ней уже открыли. Попросите пригласившего
          вас человека прислать новую.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'form') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Временный чат с {hostName}</h1>
        <p className="mt-1 text-sm text-text-muted">
          Представьтесь, чтобы начать переписку.
        </p>
        <form onSubmit={(e) => void submitEnter(e)} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm text-text-muted">Ваше имя</span>
            <input
              type="text"
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value)
                setFormError(null)
              }}
              maxLength={32}
              autoFocus
              placeholder="Например, Аня"
              className="w-full rounded-lg border border-border-strong bg-void px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-neon-cyan focus:outline-none"
            />
          </label>
          {formError ? (
            <p className="text-sm text-neon-red" role="alert">
              {formError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || nickname.trim().length === 0}
            className="w-full rounded-lg bg-on-surface px-4 py-2 font-medium text-void transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Входим…' : 'Войти'}
          </button>
          <p className="text-xs leading-relaxed text-text-muted">
            Чат существует, пока открыта эта вкладка. Закроете — вернуться будет
            нельзя.
          </p>
        </form>
      </CenterCard>
    )
  }

  if (stage.kind === 'deleted') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Чат удалён</h1>
        <p className="mt-2 text-sm text-text-muted">Вкладку можно закрыть.</p>
      </CenterCard>
    )
  }

  if (stage.kind === 'session-ended') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Сессия гостя завершена</h1>
        <p className="mt-2 text-sm text-text-muted">
          Временный чат больше недоступен. Чтобы продолжить общение, попросите
          новую ссылку.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'error') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Что-то пошло не так</h1>
        <p className="mt-2 text-sm text-text-muted">{stage.message}</p>
      </CenterCard>
    )
  }

  return (
    <GuestChatView
      hostName={hostName}
      messages={messages}
      sending={sending}
      notice={notice}
      onSend={(text) => void handleSend(text)}
      onLeave={() => void handleLeave()}
    />
  )
}

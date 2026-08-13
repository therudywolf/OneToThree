'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * "Bodiless" guest call entry: resolve the one-time link → knock with a
 * nickname → wait for the host's approval → join the LiveKit room directly
 * with the returned URL + token. ZERO session: no cookies, no stores, no
 * authed API — only the public /guest/* endpoints.
 *
 * The room itself (connect, tiles, controls, E2EE) is components/guest/
 * livekit-room-stage.tsx — the same screen the HOST sees from /meet/[room], so
 * the two sides of a meeting can never drift apart.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  resolveGuestToken,
  guestKnock,
  pollGuestKnock,
  cancelGuestKnock,
  type GuestKnockCreated,
  type GuestKnockStatus,
} from '@/lib/api/guest'
import {
  CenterCard,
  LiveKitRoomStage,
  Spinner,
  type LiveKitGrant,
} from '@/components/guest/livekit-room-stage'

// ─── Stages ─────────────────────────────────────────────────────────────────

type Stage =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'calls-unavailable' }
  | { kind: 'form' }
  | { kind: 'waiting' }
  | { kind: 'no-answer' }
  | { kind: 'denied' }
  | { kind: 'in-call'; grant: LiveKitGrant }
  | { kind: 'ended'; left: boolean }
  | { kind: 'error'; message: string }

// ─── Page client ────────────────────────────────────────────────────────────

export function GuestCallClient({ routeToken }: { routeToken: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Static export ships only /guest/call/_ — accept ?token= there (join/[code]
  // pattern).
  const token =
    routeToken && routeToken !== '_'
      ? routeToken
      : (searchParams.get('token') ?? '')

  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [hostName, setHostName] = useState('')
  const [nickname, setNickname] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const knockRef = useRef<GuestKnockCreated | null>(null)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = useCallback(() => {
    pollGenRef.current++
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // ── Step 1: resolve the token ─────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStage({ kind: 'invalid' })
      return
    }
    let alive = true
    void (async () => {
      try {
        const info = await resolveGuestToken(token)
        if (!alive) return
        if (info.kind !== 'call') {
          router.replace(`/guest/chat/${encodeURIComponent(token)}`)
          return
        }
        if (!info.can_join) {
          setStage({ kind: 'calls-unavailable' })
          return
        }
        setHostName(info.host_name)
        setStage({ kind: 'form' })
      } catch {
        if (alive) setStage({ kind: 'invalid' })
      }
    })()
    return () => {
      alive = false
    }
  }, [token, router])

  // ── Unmount: cancel a pending knock (the room tears itself down) ──────────
  useEffect(() => {
    return () => {
      stopPolling()
      const k = knockRef.current
      knockRef.current = null
      if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
    }
  }, [stopPolling])

  // ── Step 4: approved → hand the grant to the shared room stage ────────────
  const joinRoom = useCallback(
    (approved: Extract<GuestKnockStatus, { status: 'approved' }>) => {
      stopPolling()
      knockRef.current = null // one-time: nothing to cancel past this point
      setStage({
        kind: 'in-call',
        grant: {
          url: approved.livekit_url,
          token: approved.token,
          e2eeKey: approved.call_e2ee_key,
        },
      })
    },
    [stopPolling]
  )

  // ── Step 3: poll the knock until approved / denied / timed out ────────────
  const startPolling = useCallback(
    (k: GuestKnockCreated) => {
      stopPolling()
      const gen = pollGenRef.current
      const intervalMs = Math.max(1, k.poll_interval_s || 2) * 1000
      const deadline = Date.now() + Math.max(intervalMs, (k.ttl_s || 60) * 1000)

      const schedule = () => {
        pollTimerRef.current = setTimeout(() => void tick(), intervalMs)
      }
      const tick = async () => {
        if (pollGenRef.current !== gen) return
        if (Date.now() > deadline) {
          setStage({ kind: 'no-answer' })
          return
        }
        let status: GuestKnockStatus
        try {
          status = await pollGuestKnock(k.knock_id, k.knock_secret)
        } catch {
          // Transient network hiccup or already-purged knock — keep polling
          // until the ttl deadline, then declare "no answer".
          if (pollGenRef.current === gen) schedule()
          return
        }
        if (pollGenRef.current !== gen) return
        if (status.status === 'pending') {
          schedule()
          return
        }
        if (status.status === 'denied') {
          knockRef.current = null
          setStage({ kind: 'denied' })
          return
        }
        void joinRoom(status)
      }
      schedule()
    },
    [stopPolling, joinRoom]
  )

  // ── Step 2: knock with a nickname ─────────────────────────────────────────
  const submitKnock = useCallback(
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
        const k = await guestKnock(token, name)
        knockRef.current = k
        setStage({ kind: 'waiting' })
        startPolling(k)
      } catch (err) {
        const code = err instanceof Error ? err.message : ''
        switch (code) {
          case 'NICKNAME_TAKEN':
            setFormError('Это имя занято — выберите другое')
            break
          case 'INVALID_NICKNAME':
            setFormError('Недопустимое имя — используйте от 1 до 32 символов')
            break
          case 'KNOCK_PENDING':
            setFormError('Запрос уже отправлен — подождите немного')
            break
          case 'CALLS_NOT_AVAILABLE':
            setStage({ kind: 'calls-unavailable' })
            break
          case 'INVITE_NOT_FOUND':
            setStage({ kind: 'invalid' })
            break
          default:
            setFormError('Не удалось отправить запрос — попробуйте ещё раз')
        }
      } finally {
        setBusy(false)
      }
    },
    [nickname, token, startPolling]
  )

  const cancelWaiting = useCallback(() => {
    stopPolling()
    const k = knockRef.current
    knockRef.current = null
    if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
    setFormError(null)
    setStage({ kind: 'form' })
  }, [stopPolling])

  // ── Screens ───────────────────────────────────────────────────────────────

  if (stage.kind === 'loading') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-neutral-400">Проверяем приглашение…</p>
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
        <p className="mt-2 text-sm text-neutral-400">
          Попросите пригласившего вас человека прислать новую ссылку.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'calls-unavailable') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          Звонки на этом сервере недоступны
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Присоединиться к встрече по этой ссылке сейчас нельзя.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'form') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Встреча у {hostName}</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Представьтесь, чтобы постучаться в комнату.
        </p>
        <form onSubmit={(e) => void submitKnock(e)} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-300">
              Ваше имя
            </span>
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
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </label>
          {formError ? (
            <p className="text-sm text-red-400" role="alert">
              {formError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || nickname.trim().length === 0}
            className="w-full rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Отправляем…' : 'Постучаться'}
          </button>
        </form>
      </CenterCard>
    )
  }

  if (stage.kind === 'waiting') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <Spinner />
          <p className="text-sm text-neutral-300">
            Ждём, пока {hostName} вас впустит…
          </p>
          <button
            type="button"
            onClick={cancelWaiting}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition hover:bg-neutral-800"
          >
            Отменить
          </button>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'no-answer') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Никто не ответил</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {hostName} не отреагировал(а) на ваш запрос вовремя.
        </p>
        <button
          type="button"
          onClick={() => {
            setFormError(null)
            setStage({ kind: 'form' })
          }}
          className="mt-4 w-full rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-900 transition hover:bg-white"
        >
          Попробовать ещё раз
        </button>
      </CenterCard>
    )
  }

  if (stage.kind === 'denied') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Вам отказали во входе</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {hostName} не впустил(а) вас в эту встречу.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'ended') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          {stage.left
            ? 'Встреча завершена'
            : 'Вы покинули встречу или были отключены'}
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          {stage.left
            ? 'Можете закрыть вкладку.'
            : 'Если это произошло по ошибке — попросите новую ссылку.'}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'error') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Не получилось подключиться</h1>
        <p className="mt-2 text-sm text-neutral-400">{stage.message}</p>
      </CenterCard>
    )
  }

  // ── In-call: the shared room stage, identical to the host's /meet view ────
  return (
    <LiveKitRoomStage
      grant={stage.grant}
      title={`Встреча у ${hostName}`}
      selfIsGuest
      onEnded={(left) => setStage({ kind: 'ended', left })}
      onError={(message) => setStage({ kind: 'error', message })}
    />
  )
}

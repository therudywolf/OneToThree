'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Host view of a standalone guest meeting room.
 *
 * The room is a bare LiveKit room (not a chat), so the token comes from the
 * normal POST /api/call/token — the server authorizes the creator of a live
 * guest link for that room. The room screen itself is the SAME component the
 * guest sees after approval; here it additionally gets the kick control.
 *
 * The knock overlay is mounted too: knocks arrive over the app WS, and the host
 * is most likely to be sitting on this very screen when a guest arrives.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createCallToken } from '@/lib/api/call'
import { kickGuestFromCall } from '@/lib/api/guest'
import {
  CenterCard,
  LiveKitRoomStage,
  Spinner,
  type LiveKitGrant,
} from '@/components/guest/livekit-room-stage'
import { GuestKnockOverlay } from '@/components/guest/guest-knock-overlay'

type Stage =
  | { kind: 'loading' }
  | { kind: 'in-call'; grant: LiveKitGrant }
  | { kind: 'ended' }
  | { kind: 'error'; message: string }

export function HostMeetingClient({ routeRoom }: { routeRoom: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Static export ships only /meet/_ — accept ?room= there.
  const room =
    routeRoom && routeRoom !== '_' ? routeRoom : (searchParams.get('room') ?? '')

  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  /** Bumped to re-enter the same room after leaving (the room id never changes). */
  const [joinNonce, setJoinNonce] = useState(0)

  useEffect(() => {
    if (!room) {
      setStage({ kind: 'error', message: 'Не указана комната встречи.' })
      return
    }
    let alive = true
    void (async () => {
      try {
        const t = await createCallToken(room)
        if (!alive) return
        setStage({
          kind: 'in-call',
          grant: { url: t.url, token: t.token, e2eeKey: t.call_e2ee_key },
        })
      } catch (err) {
        if (!alive) return
        const code = err instanceof Error ? err.message : ''
        setStage({
          kind: 'error',
          message:
            code === 'NOT_A_MEMBER'
              ? 'Эта встреча вам не принадлежит или её ссылка отозвана.'
              : code === 'LIVEKIT_NOT_CONFIGURED' || code === 'LIVEKIT_SECRET_TOO_SHORT'
                ? 'Звонки на этом сервере не настроены.'
                : 'Не удалось открыть встречу. Попробуйте ещё раз.',
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [room, joinNonce])

  const kick = useCallback(
    async (identity: string) => {
      await kickGuestFromCall(room, identity)
    },
    [room]
  )

  if (stage.kind === 'loading') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-neutral-400">Открываем встречу…</p>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'error') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Встреча недоступна</h1>
        <p className="mt-2 text-sm text-neutral-400">{stage.message}</p>
        <button
          type="button"
          onClick={() => router.push('/')}
          className="mt-4 w-full rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-900 transition hover:bg-white"
        >
          К чатам
        </button>
      </CenterCard>
    )
  }

  if (stage.kind === 'ended') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Вы вышли из встречи</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Комната остаётся доступной по той же ссылке, пока у неё есть места и
          не истёк срок.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setStage({ kind: 'loading' })
              setJoinNonce((n) => n + 1)
            }}
            className="flex-1 rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800"
          >
            Вернуться
          </button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="flex-1 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white"
          >
            К чатам
          </button>
        </div>
      </CenterCard>
    )
  }

  return (
    <>
      <LiveKitRoomStage
        grant={stage.grant}
        title="Быстрая встреча"
        onKickGuest={kick}
        onEnded={() => setStage({ kind: 'ended' })}
        onError={(message) => setStage({ kind: 'error', message })}
      />
      {/* Approve knocks without leaving the meeting. */}
      <GuestKnockOverlay />
    </>
  )
}

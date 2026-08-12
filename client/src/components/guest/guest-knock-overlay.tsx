'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Floating "guest is knocking" cards (docs/project/GUEST_MODE_CONCEPT.ru.md
 * §3.2 step 4). Subscribes to the app WS: `guest_knock` adds a card,
 * `guest_knock_cancelled` removes it; cards auto-expire with the knock's
 * 5-minute server TTL. Approve/deny call the creator-side endpoints — approval
 * is what releases the LiveKit grant to the polling guest.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DoorOpen } from 'lucide-react'
import { getFmSocket } from '@/lib/api/socket'
import { approveGuestKnock, denyGuestKnock } from '@/lib/api/guest'
import { useTranslation } from '@/hooks/use-translation'

type KnockCard = {
  id: string
  nickname: string
  chatId: string | null
  expiresAt: number
  busy: boolean
  error: string | null
}

const KNOCK_TTL_MS = 5 * 60_000

export function GuestKnockOverlay() {
  const { t } = useTranslation()
  const [knocks, setKnocks] = useState<KnockCard[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const removeKnock = useCallback((id: string) => {
    setKnocks((prev) => prev.filter((k) => k.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    const unsubscribe = getFmSocket().subscribe((m) => {
      if (m.type === 'guest_knock') {
        const { knock_id: id, nickname, chat_id: chatId } = m
        setKnocks((prev) =>
          prev.some((k) => k.id === id)
            ? prev
            : [
                ...prev,
                {
                  id,
                  nickname,
                  chatId: chatId ?? null,
                  expiresAt: Date.now() + KNOCK_TTL_MS,
                  busy: false,
                  error: null,
                },
              ]
        )
        const timer = setTimeout(() => removeKnock(id), KNOCK_TTL_MS)
        timers.set(id, timer)
      } else if (m.type === 'guest_knock_cancelled') {
        removeKnock(m.knock_id)
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [removeKnock])

  const act = useCallback(
    async (id: string, action: 'approve' | 'deny') => {
      setKnocks((prev) =>
        prev.map((k) => (k.id === id ? { ...k, busy: true, error: null } : k))
      )
      try {
        if (action === 'approve') await approveGuestKnock(id)
        else await denyGuestKnock(id)
        removeKnock(id)
      } catch (err) {
        setKnocks((prev) =>
          prev.map((k) =>
            k.id === id
              ? {
                  ...k,
                  busy: false,
                  error: err instanceof Error ? err.message : 'ERROR',
                }
              : k
          )
        )
      }
    },
    [removeKnock]
  )

  if (knocks.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[95] flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2">
      {knocks.map((k) => (
        <div
          key={k.id}
          className="rounded-lg border border-amber-500/40 bg-neutral-900/95 p-3 shadow-xl backdrop-blur"
          role="alertdialog"
          aria-label={t('guest.knockTitle')}
        >
          <div className="flex items-center gap-2">
            <DoorOpen className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-100">
                {k.nickname}
                <span className="ml-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                  {t('guest.badge')}
                </span>
              </div>
              <div className="text-xs text-neutral-400">{t('guest.knockBody')}</div>
            </div>
          </div>
          {k.error ? (
            <div className="mt-1.5 text-xs text-red-400">{k.error}</div>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={k.busy}
              onClick={() => void act(k.id, 'approve')}
              className="flex-1 rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {t('guest.admit')}
            </button>
            <button
              type="button"
              disabled={k.busy}
              onClick={() => void act(k.id, 'deny')}
              className="flex-1 rounded-md bg-neutral-700 px-2 py-1.5 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-600 disabled:opacity-50"
            >
              {t('guest.deny')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Floating "guest is knocking" cards (docs/project/GUEST_MODE_CONCEPT.ru.md
 * §3.2 step 4). Subscribes to the app WS: `guest_knock` adds a card,
 * `guest_knock_cancelled` removes it; cards auto-expire with the knock's
 * 5-minute server TTL. Approve/deny call the creator-side endpoints — approval
 * is what releases the LiveKit grant to the polling guest.
 *
 * The WS is not the only source. A knock raised while the host had no socket is
 * broadcast to nobody and only produces a push; the host taps it, connects after
 * the fact, and the event is long gone. So the overlay also HYDRATES from
 * GET /guest/knocks on mount and on every offline→online edge, merged by knock
 * id with whatever the socket already delivered.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DoorOpen } from 'lucide-react'
import { getFmSocket } from '@/lib/api/socket'
import {
  approveGuestKnock,
  denyGuestKnock,
  listPendingGuestKnocks,
  type GuestPendingKnock,
} from '@/lib/api/guest'
import { useTranslation } from '@/hooks/use-translation'
import { playKnockSound } from '@/lib/call-ringtones'
import { useChatStore } from '@/store/chatStore'

export type KnockCard = {
  id: string
  nickname: string
  chatId: string | null
  /** The room the grant admits into — `chat_id` when there is one, else the
   *  standalone meeting room. Always set by the server. */
  roomId: string | null
  expiresAt: number
  busy: boolean
  error: string | null
}

const KNOCK_TTL_MS = 5 * 60_000

/**
 * How many knock cards may be on screen at once. Above this the overlay stops
 * being a notification and becomes a wall: a ten-seat meeting filling up at
 * once would otherwise cover the chat the host is standing in.
 */
const MAX_VISIBLE_CARDS = 3

/**
 * Fold a hydration snapshot into the cards already on screen.
 *
 * The knock id is the identity: the same knock reaches us over the WS AND in
 * every snapshot until it is answered, so re-adding it would stack duplicate
 * cards on top of each other. An existing card always wins — it may be mid
 * approve/deny (`busy`) or showing the error from a failed one, and neither may
 * be reset by a refetch. Nothing is REMOVED here: a card the socket delivered
 * microseconds after the server built the snapshot is not stale.
 */
export function mergeKnockCards(
  prev: KnockCard[],
  pending: GuestPendingKnock[],
  now: number = Date.now()
): KnockCard[] {
  const known = new Set(prev.map((k) => k.id))
  const added: KnockCard[] = []
  for (const p of pending) {
    if (known.has(p.knock_id)) continue
    known.add(p.knock_id)
    added.push({
      id: p.knock_id,
      nickname: p.nickname,
      chatId: p.chat_id ?? null,
      roomId: p.room_id ?? p.chat_id ?? null,
      expiresAt: knockExpiry(p.expires_at, now),
      busy: false,
      error: null,
    })
  }
  return added.length === 0 ? prev : [...prev, ...added]
}

/**
 * A hydrated knock is already part-way through its window, so the server's
 * `expires_at` is what the card must count down to — `now + TTL` would keep a
 * dead card on screen for another five minutes. An absent or unparseable value
 * (older server) falls back to the full TTL.
 */
function knockExpiry(expiresAt: string | null | undefined, now: number): number {
  if (!expiresAt) return now + KNOCK_TTL_MS
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? now + KNOCK_TTL_MS : at
}

type Props = {
  /**
   * Put this host into the room the guest is about to be let into, if they are
   * not there already (#5).
   *
   * A guest is always admitted into the SFU room named after the chat, but a
   * 1:1 call is peer-to-peer — so "admit" used to drop the guest into an empty
   * room while the two hosts kept talking on a link the guest was not on. This
   * runs BEFORE the approval, so the room is never empty when the grant lands.
   */
  onAdmit?: (roomId: string | null) => Promise<void>
}

export function GuestKnockOverlay({ onAdmit }: Props = {}) {
  const { t } = useTranslation()
  const [knocks, setKnocks] = useState<KnockCard[]>([])
  const soundEnabled = useChatStore((s) => s.chatSoundEnabled)

  const removeKnock = useCallback((id: string) => {
    setKnocks((prev) => prev.filter((k) => k.id !== id))
  }, [])

  // Read-only mirror of the cards, so `act` can look one up without taking
  // `knocks` as a dependency — it is called from a render-stable handler and
  // re-creating it on every card change would re-arm the expiry timers.
  const knocksRef = useRef<KnockCard[]>([])
  knocksRef.current = knocks

  useEffect(() => {
    const unsubscribe = getFmSocket().subscribe((m) => {
      if (m.type === 'guest_knock') {
        const { knock_id: id, nickname, chat_id: chatId, room_id: roomId } = m
        setKnocks((prev) => {
          if (prev.some((k) => k.id === id)) return prev
          // A knock is a person waiting behind a door with a five-minute
          // window. The card alone only works if the host happens to be
          // looking at this tab — which, since the host is usually the one who
          // just sent the link somewhere else, is exactly when they are not.
          // Unlike the message chime this fires even with the window focused:
          // the card can be off-screen on a long chat list.
          if (soundEnabled) playKnockSound()
          return [
            ...prev,
            {
              id,
              nickname,
              chatId: chatId ?? null,
              roomId: roomId ?? chatId ?? null,
              expiresAt: Date.now() + KNOCK_TTL_MS,
              busy: false,
              error: null,
            },
          ]
        })
      } else if (m.type === 'guest_knock_cancelled') {
        removeKnock(m.knock_id)
      }
    })
    return unsubscribe
  }, [removeKnock, soundEnabled])

  // Hydration: the mount pull covers "host tapped the push", the connect edge
  // covers "the socket was down while a guest knocked".
  useEffect(() => {
    let cancelled = false
    const socket = getFmSocket()

    const hydrate = async () => {
      let pending: GuestPendingKnock[]
      try {
        pending = await listPendingGuestKnocks()
      } catch {
        // Nothing to show and nothing to say: WS delivery still works, and a
        // server without the endpoint must not paint an error over the app.
        return
      }
      if (cancelled) return
      setKnocks((prev) => mergeKnockCards(prev, pending))
    }

    void hydrate()

    // subscribeStatus fires immediately with the current state and again on
    // every connect/disconnect; refetch only on a false→true edge, since the
    // mount pull above already covers "connected all along".
    let wasConnected = socket.connected
    const offStatus = socket.subscribeStatus(() => {
      const nowConnected = socket.connected
      if (nowConnected && !wasConnected) void hydrate()
      wasConnected = nowConnected
    })

    return () => {
      cancelled = true
      offStatus()
    }
  }, [])

  // One expiry timer per card, re-armed off the card's own deadline whenever the
  // set changes — a hydrated knock may have seconds left, not the full TTL.
  useEffect(() => {
    if (knocks.length === 0) return
    const timers = knocks.map((k) =>
      setTimeout(() => removeKnock(k.id), Math.max(0, k.expiresAt - Date.now()))
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [knocks, removeKnock])

  const act = useCallback(
    async (id: string, action: 'approve' | 'deny') => {
      const card = knocksRef.current.find((k) => k.id === id) ?? null
      setKnocks((prev) =>
        prev.map((k) => (k.id === id ? { ...k, busy: true, error: null } : k))
      )
      try {
        if (action === 'approve') {
          // Best-effort, and deliberately not fatal: a guest kept waiting
          // because the host's own call could not be migrated is strictly worse
          // than a guest who lands in a room the host then has to join by hand.
          try {
            await onAdmit?.(card?.roomId ?? card?.chatId ?? null)
          } catch (err) {
            console.warn('[guest] could not move the call into the room', err)
          }
          await approveGuestKnock(id)
        } else await denyGuestKnock(id)
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
    [removeKnock, onAdmit]
  )

  if (knocks.length === 0) return null

  // A meeting link seats up to fifty. Rendering one card per knock stacked them
  // bottom-up until they covered the app the host is trying to use — and the
  // oldest knock, the one closest to timing out, was the one pushed off screen.
  // Show the oldest few (they expire first, so they are the urgent ones) and
  // count the rest.
  const visible = knocks.slice(0, MAX_VISIBLE_CARDS)
  const hidden = knocks.length - visible.length

  return (
    <div className="fixed bottom-4 right-4 z-[95] flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2">
      {hidden > 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface-elevated/95 px-3 py-1.5 text-center text-xs text-text-muted shadow-xl backdrop-blur">
          {t('guest.moreKnocks').replace('{n}', String(hidden))}
        </div>
      ) : null}
      {visible.map((k) => (
        <div
          key={k.id}
          className="rounded-lg border border-neon-amber/40 bg-surface-elevated/95 p-3 shadow-xl backdrop-blur"
          role="alertdialog"
          aria-label={t('guest.knockTitle')}
        >
          <div className="flex items-center gap-2">
            <DoorOpen className="h-5 w-5 shrink-0 text-neon-amber" aria-hidden />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text-primary">
                {k.nickname}
                <span className="ml-1.5 rounded bg-neon-amber/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neon-amber">
                  {t('guest.badge')}
                </span>
              </div>
              <div className="text-xs text-text-muted">{t('guest.knockBody')}</div>
            </div>
          </div>
          {k.error ? (
            <div className="mt-1.5 text-xs text-neon-red">{k.error}</div>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={k.busy}
              onClick={() => void act(k.id, 'approve')}
              className="flex-1 rounded-md bg-success px-2 py-1.5 text-xs font-semibold text-void transition hover:opacity-90 disabled:opacity-50"
            >
              {t('guest.admit')}
            </button>
            <button
              type="button"
              disabled={k.busy}
              onClick={() => void act(k.id, 'deny')}
              className="flex-1 rounded-md bg-surface-elevated px-2 py-1.5 text-xs font-semibold text-text-primary transition hover:bg-neon-cyan/10 disabled:opacity-50"
            >
              {t('guest.deny')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

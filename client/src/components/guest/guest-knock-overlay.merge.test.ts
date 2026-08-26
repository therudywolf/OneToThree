// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The overlay now has TWO sources for the same card — the `guest_knock` socket
 * event and the GET /guest/knocks snapshot it pulls on mount and on every
 * reconnect. Both carry the same knock, so the merge is what decides whether
 * the host sees one card or a growing stack of identical ones, and whether a
 * card they are in the middle of approving survives a refetch.
 */

import { describe, expect, it } from 'vitest'
import { mergeKnockCards, type KnockCard } from './guest-knock-overlay'
import type { GuestPendingKnock } from '@/lib/api/guest'

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)
const TTL_MS = 5 * 60_000

function pending(over: Partial<GuestPendingKnock> = {}): GuestPendingKnock {
  return {
    knock_id: 'k1',
    nickname: 'Аня',
    chat_id: null,
    room_id: 'room-1',
    ...over,
  }
}

function card(over: Partial<KnockCard> = {}): KnockCard {
  return {
    id: 'k1',
    nickname: 'Аня',
    chatId: null,
    roomId: 'room-1',
    expiresAt: NOW + TTL_MS,
    busy: false,
    error: null,
    ...over,
  }
}

describe('mergeKnockCards', () => {
  it('adds a knock the socket never delivered', () => {
    const merged = mergeKnockCards([], [pending({ knock_id: 'k9', nickname: 'Гость' })], NOW)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'k9',
      nickname: 'Гость',
      chatId: null,
      busy: false,
      error: null,
    })
  })

  it('never duplicates a card the socket already delivered', () => {
    const merged = mergeKnockCards([card()], [pending()], NOW)
    expect(merged).toHaveLength(1)
    expect(merged.map((k) => k.id)).toEqual(['k1'])
  })

  it('leaves an in-flight card exactly as it was', () => {
    // A refetch landing mid-approve must not clear `busy` (the buttons would go
    // live again under a second click) nor the error text from a failed one.
    const inFlight = card({ busy: true, error: 'APPROVE_FAILED' })
    const merged = mergeKnockCards([inFlight], [pending()], NOW)
    expect(merged[0]).toBe(inFlight)
  })

  it('returns the very same array when the snapshot brings nothing new', () => {
    // Identity matters: the expiry timers are re-armed off this array, so a
    // fresh copy on every poll would restart every countdown.
    const prev = [card()]
    expect(mergeKnockCards(prev, [pending()], NOW)).toBe(prev)
    expect(mergeKnockCards(prev, [], NOW)).toBe(prev)
  })

  it('keeps a knock repeated inside one snapshot to a single card', () => {
    const merged = mergeKnockCards([], [pending(), pending()], NOW)
    expect(merged).toHaveLength(1)
  })

  it('counts down to the server deadline, not to a fresh full TTL', () => {
    // Hydration happens mid-window: a knock with 40 s left must disappear in
    // 40 s, not linger for another five minutes over a dead knock id.
    const expiresAt = new Date(NOW + 40_000).toISOString()
    const merged = mergeKnockCards([], [pending({ expires_at: expiresAt })], NOW)
    expect(merged[0].expiresAt).toBe(NOW + 40_000)
  })

  it('falls back to the full TTL when the server sends no deadline', () => {
    expect(mergeKnockCards([], [pending()], NOW)[0].expiresAt).toBe(NOW + TTL_MS)
    expect(
      mergeKnockCards([], [pending({ expires_at: 'not a date' })], NOW)[0].expiresAt
    ).toBe(NOW + TTL_MS)
    expect(mergeKnockCards([], [pending({ expires_at: null })], NOW)[0].expiresAt).toBe(
      NOW + TTL_MS
    )
  })

  it('carries the chat a chat-bound knock belongs to', () => {
    const merged = mergeKnockCards([], [pending({ chat_id: 'chat-7' })], NOW)
    expect(merged[0].chatId).toBe('chat-7')
  })
})

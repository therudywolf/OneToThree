// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Guest knock store (docs/project/GUEST_MODE_CONCEPT.ru.md §3.2).
// ---------------------------------------------------------------------------
// A knock is an UNAUTHENTICATED "guest X wants into your call" request created
// from a one-time guest link. Until the creator approves, the guest exists
// ONLY here (Redis / in-process fallback) — never in Postgres. Modeled on
// device-rendezvous-store.ts: TTL'd JSON blobs, secret-hash gated polling,
// one-time result pickup.
//
// Pending knocks are capped per invite by its REMAINING seats: a one-time
// temp-chat link admits a single waiting guest, a meeting link admits as many
// as it still has seats for (each approved individually). Over the cap the
// knock is refused with KNOCK_PENDING rather than queued, so the host is never
// buried under a stack of cards. A deny/cancel/pickup frees the slot; an
// approve takes a real seat in Postgres (`used_count`).
// ---------------------------------------------------------------------------

import { getRedis } from './redis.js'

export type GuestKnockStatus = 'pending' | 'approved' | 'denied'

export type GuestKnock = {
  inviteId: string
  /** LiveKit room the knock targets: chat uuid or a standalone room uuid. */
  roomId: string
  /** Chat the room belongs to, when the link targets an existing chat's call. */
  chatId: string | null
  /** The link creator — the only account allowed to approve/deny. */
  creatorId: string
  nickname: string
  /** SHA-256 hex of the poll secret held only by the knocking guest. */
  secretHash: string
  canPublish: boolean
  status: GuestKnockStatus
  /**
   * Set on approve; picked up EXACTLY ONCE by the guest's poll (the pickup
   * deletes the knock). Carries everything needed to join the LiveKit room.
   */
  grant: {
    livekitUrl: string
    token: string
    identity: string
    e2eeKey: string
  } | null
  /** Absolute expiry (ms epoch). */
  exp: number
}

const KEY_PREFIX = 'fm:guest:knock:'
const SLOT_PREFIX = 'fm:guest:knock:invite:'
/** The creator must react within this window. */
export const KNOCK_TTL_S = 300

const mem = new Map<string, GuestKnock>()
/** inviteId → knockId → absolute expiry (ms). Redis-less fallback. */
const memSlots = new Map<string, Map<string, number>>()

function ttlSecondsFor(exp: number): number {
  return Math.max(1, Math.ceil((exp - Date.now()) / 1000))
}

function memSlotsFor(inviteId: string): Map<string, number> {
  const now = Date.now()
  const slots = memSlots.get(inviteId) ?? new Map<string, number>()
  for (const [id, exp] of slots) if (exp <= now) slots.delete(id)
  memSlots.set(inviteId, slots)
  return slots
}

/**
 * Reserve one of the invite's pending-knock slots. `maxPending` is the link's
 * remaining seat count. Returns false when the waiting room is already full.
 */
export async function reserveKnockSlot(
  inviteId: string,
  knockId: string,
  maxPending = 1
): Promise<boolean> {
  const limit = Math.max(1, maxPending)
  const r = getRedis()
  if (r) {
    const key = `${SLOT_PREFIX}${inviteId}`
    await r.sadd(key, knockId)
    await r.expire(key, KNOCK_TTL_S)
    const size = await r.scard(key)
    if (size > limit) {
      await r.srem(key, knockId)
      return false
    }
    return true
  }
  const slots = memSlotsFor(inviteId)
  if (slots.size >= limit) return false
  slots.set(knockId, Date.now() + KNOCK_TTL_S * 1000)
  return true
}

/** Free one pending slot (deny / cancel / result pickup / expiry). */
export async function releaseKnockSlot(
  inviteId: string,
  knockId: string
): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.srem(`${SLOT_PREFIX}${inviteId}`, knockId)
    return
  }
  const slots = memSlotsFor(inviteId)
  slots.delete(knockId)
}

export async function saveKnock(id: string, payload: GuestKnock): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.set(
      `${KEY_PREFIX}${id}`,
      JSON.stringify(payload),
      'EX',
      ttlSecondsFor(payload.exp)
    )
    return
  }
  mem.set(id, payload)
}

export async function getKnock(id: string): Promise<GuestKnock | null> {
  const r = getRedis()
  if (r) {
    const raw = await r.get(`${KEY_PREFIX}${id}`)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as GuestKnock
      return Date.now() > p.exp ? null : p
    } catch {
      return null
    }
  }
  const row = mem.get(id)
  if (!row || Date.now() > row.exp) {
    if (row) mem.delete(id)
    return null
  }
  return row
}

/** Atomically read-and-delete (one-time result pickup / cancel). */
export async function consumeKnock(id: string): Promise<GuestKnock | null> {
  const r = getRedis()
  if (r) {
    const raw = await r.getdel(`${KEY_PREFIX}${id}`)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as GuestKnock
      return Date.now() > p.exp ? null : p
    } catch {
      return null
    }
  }
  const row = mem.get(id)
  mem.delete(id)
  if (!row || Date.now() > row.exp) return null
  return row
}

/** Test / shutdown hook. */
export function _resetGuestKnocksForTests(): void {
  mem.clear()
  memSlots.clear()
}

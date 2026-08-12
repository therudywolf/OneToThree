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
// One-pending-knock-per-invite invariant: a one-time link admits one guest, so
// while a knock for invite X is pending, further knocks on X get KNOCK_PENDING.
// A deny releases the slot (the right person may still use the link); an
// approve consumes the link itself in Postgres (`used_at`), so the slot never
// matters again.
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
const memSlots = new Map<string, { knockId: string; exp: number }>()

function ttlSecondsFor(exp: number): number {
  return Math.max(1, Math.ceil((exp - Date.now()) / 1000))
}

/**
 * Reserve the invite's single pending-knock slot. Returns false when another
 * knock is already pending for this invite.
 */
export async function reserveKnockSlot(
  inviteId: string,
  knockId: string
): Promise<boolean> {
  const r = getRedis()
  if (r) {
    const ok = await r.set(
      `${SLOT_PREFIX}${inviteId}`,
      knockId,
      'EX',
      KNOCK_TTL_S,
      'NX'
    )
    return ok === 'OK'
  }
  const slot = memSlots.get(inviteId)
  if (slot && Date.now() <= slot.exp) return false
  memSlots.set(inviteId, { knockId, exp: Date.now() + KNOCK_TTL_S * 1000 })
  return true
}

export async function releaseKnockSlot(inviteId: string): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.del(`${SLOT_PREFIX}${inviteId}`)
    return
  }
  memSlots.delete(inviteId)
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

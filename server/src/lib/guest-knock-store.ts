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
// buried under a stack of cards. An approve/deny/cancel/pickup frees the slot,
// and a slot nobody ever answered expires on its own; an approve takes a real
// seat in Postgres (`used_count`), given back when the guest leaves the room.
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
/**
 * ZSET of pending knock ids scored by their ABSOLUTE expiry (ms epoch).
 *
 * It used to be a SET, and Redis gives set members no individual TTL: a slot
 * was freed only by an explicit release (deny / cancel / pickup), so a knock
 * nobody ever answered — tab closed, guest walked away — held a seat forever,
 * while the unconditional key-level `expire` on every attempt pushed the whole
 * room's TTL another 300s out, so the ghost outlived the window that created
 * it. A one-seat link ended up permanently refusing everyone with
 * KNOCK_PENDING. Scored members expire one by one; the key name is
 * deliberately NOT the old one, so a rolling deploy meets no SET left behind
 * by the previous process (WRONGTYPE on the first knock).
 */
const SLOT_PREFIX = 'fm:guest:knock:slot:'
/**
 * ZSET of a creator's pending knock ids, same scoring — the hydration source
 * for GET /guest/knocks. The `guest_knock` WS push dead-ends when the host has
 * no live socket (the overlay is event-only), so a host who was offline, or
 * merely reloading, never learned anyone was waiting at the door.
 */
const CREATOR_PREFIX = 'fm:guest:knock:creator:'
/**
 * room+identity → the invite whose seat that guest is sitting in, so the
 * LiveKit `participant_left` webhook can give the seat back. `max_uses` is
 * CONCURRENT capacity (that is what the UI promises), not a lifetime ticket:
 * without this a reload burned a second seat and a live 6-person meeting could
 * exhaust its own link.
 */
const SEAT_PREFIX = 'fm:guest:seat:'
/** Safety net only; the authoritative release is the participant_left webhook. */
const SEAT_TTL_S = 60 * 60 * 8
/** The creator must react within this window. */
export const KNOCK_TTL_S = 300
/** Hydration is a card stack, not a mailbox — cap what one GET can fan out to. */
const MAX_HYDRATED_KNOCKS = 50

/**
 * Prune expired members, refuse when the waiting room is already full,
 * otherwise take the slot — in ONE round trip. The old
 * sadd→expire→scard→srem sequence was not atomic: two knocks racing for the
 * last seat on a one-seat link both saw a count of 2 and both refused
 * themselves, leaving the seat empty and both guests told to try again.
 */
const RESERVE_SLOT_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local now = tonumber(ARGV[2])
local expiresAt = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
redis.call('zremrangebyscore', key, '-inf', now)
if redis.call('zcard', key) >= limit then
  return 0
end
redis.call('zadd', key, expiresAt, member)
redis.call('expire', key, ttl)
return 1
`

const mem = new Map<string, GuestKnock>()
/** inviteId → knockId → absolute expiry (ms). Redis-less fallback. */
const memSlots = new Map<string, Map<string, number>>()
/** creatorId → knockId → absolute expiry (ms). Redis-less fallback. */
const memCreatorKnocks = new Map<string, Map<string, number>>()
/** `${roomId}:${identity}` → inviteId. Redis-less fallback. */
const memSeats = new Map<string, string>()

function ttlSecondsFor(exp: number): number {
  return Math.max(1, Math.ceil((exp - Date.now()) / 1000))
}

function memIndexFor(
  index: Map<string, Map<string, number>>,
  ownerId: string
): Map<string, number> {
  const now = Date.now()
  const slots = index.get(ownerId) ?? new Map<string, number>()
  for (const [id, exp] of slots) if (exp <= now) slots.delete(id)
  index.set(ownerId, slots)
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
  const now = Date.now()
  const r = getRedis()
  if (r) {
    const taken = await r.eval(
      RESERVE_SLOT_LUA,
      1,
      `${SLOT_PREFIX}${inviteId}`,
      knockId,
      String(now),
      String(now + KNOCK_TTL_S * 1000),
      String(limit),
      String(KNOCK_TTL_S)
    )
    return Number(taken) === 1
  }
  const slots = memIndexFor(memSlots, inviteId)
  if (slots.size >= limit) return false
  slots.set(knockId, now + KNOCK_TTL_S * 1000)
  return true
}

/** Free one pending slot (approve / deny / cancel / result pickup / expiry). */
export async function releaseKnockSlot(
  inviteId: string,
  knockId: string
): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.zrem(`${SLOT_PREFIX}${inviteId}`, knockId)
    return
  }
  const slots = memIndexFor(memSlots, inviteId)
  slots.delete(knockId)
}

/** Keep the creator's pending-knock index in step with the knock's status. */
async function indexKnockForCreator(id: string, payload: GuestKnock): Promise<void> {
  const pending = payload.status === 'pending'
  const r = getRedis()
  if (r) {
    const key = `${CREATOR_PREFIX}${payload.creatorId}`
    if (!pending) {
      await r.zrem(key, id)
      return
    }
    await r.zremrangebyscore(key, '-inf', Date.now())
    await r.zadd(key, payload.exp, id)
    await r.expire(key, KNOCK_TTL_S)
    return
  }
  const slots = memIndexFor(memCreatorKnocks, payload.creatorId)
  if (pending) slots.set(id, payload.exp)
  else slots.delete(id)
}

async function dropCreatorKnock(creatorId: string, id: string): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.zrem(`${CREATOR_PREFIX}${creatorId}`, id)
    return
  }
  memIndexFor(memCreatorKnocks, creatorId).delete(id)
}

export type PendingGuestKnock = { id: string; knock: GuestKnock }

/**
 * The creator's knocks still waiting at the door, oldest first. Entries whose
 * payload is gone (picked up, expired) are dropped from the index as we pass.
 */
export async function listPendingKnocksForCreator(
  creatorId: string
): Promise<PendingGuestKnock[]> {
  const r = getRedis()
  let ids: string[]
  if (r) {
    const key = `${CREATOR_PREFIX}${creatorId}`
    await r.zremrangebyscore(key, '-inf', Date.now())
    ids = await r.zrange(key, 0, MAX_HYDRATED_KNOCKS - 1)
  } else {
    ids = [...memIndexFor(memCreatorKnocks, creatorId).keys()].slice(
      0,
      MAX_HYDRATED_KNOCKS
    )
  }
  const out: PendingGuestKnock[] = []
  for (const id of ids) {
    const knock = await getKnock(id)
    if (!knock || knock.status !== 'pending' || knock.creatorId !== creatorId) {
      await dropCreatorKnock(creatorId, id)
      continue
    }
    out.push({ id, knock })
  }
  return out
}

/** Remember which link paid for an approved guest's seat (see SEAT_PREFIX). */
export async function rememberSeatHolder(
  roomId: string,
  identity: string,
  inviteId: string
): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.set(`${SEAT_PREFIX}${roomId}:${identity}`, inviteId, 'EX', SEAT_TTL_S)
    return
  }
  memSeats.set(`${roomId}:${identity}`, inviteId)
}

/**
 * Read-and-delete the seat a leaving guest held: the invite id when this
 * identity actually took a seat, null otherwise. The delete is what keeps a
 * duplicated or stray `participant_left` from driving `used_count` negative.
 */
export async function takeSeatHolder(
  roomId: string,
  identity: string
): Promise<string | null> {
  const r = getRedis()
  if (r) {
    return (await r.getdel(`${SEAT_PREFIX}${roomId}:${identity}`)) ?? null
  }
  const key = `${roomId}:${identity}`
  const inviteId = memSeats.get(key) ?? null
  memSeats.delete(key)
  return inviteId
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
    await indexKnockForCreator(id, payload)
    return
  }
  mem.set(id, payload)
  await indexKnockForCreator(id, payload)
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
      await dropCreatorKnock(p.creatorId, id)
      return Date.now() > p.exp ? null : p
    } catch {
      return null
    }
  }
  const row = mem.get(id)
  mem.delete(id)
  if (row) await dropCreatorKnock(row.creatorId, id)
  if (!row || Date.now() > row.exp) return null
  return row
}

/** Test / shutdown hook. */
export function _resetGuestKnocksForTests(): void {
  mem.clear()
  memSlots.clear()
  memCreatorKnocks.clear()
  memSeats.clear()
}

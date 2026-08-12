// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Per-room log of call guests — the ONLY trace a bodiless call guest leaves.
// Accumulated in Redis while the room is live (approve → joined, webhook →
// left, kick → kicked) and drained into `call_sessions.guests` jsonb when the
// room finishes. Entries are plain nicknames + timestamps; no user ids exist
// for call guests by design (docs/project/GUEST_MODE_CONCEPT.ru.md §3.4).

import { getRedis } from './redis.js'

export type GuestCallLogEntry = {
  identity: string
  nick: string
  joined_at: string
  left_at?: string
  kicked?: boolean
}

const KEY_PREFIX = 'fm:guest:calllog:'
/** Safety-net TTL; the authoritative cleanup is the room_finished drain. */
const LOG_TTL_S = 60 * 60 * 8

const mem = new Map<string, Map<string, GuestCallLogEntry>>()

async function readAll(roomId: string): Promise<Map<string, GuestCallLogEntry>> {
  const r = getRedis()
  if (r) {
    const raw = await r.hgetall(`${KEY_PREFIX}${roomId}`)
    const map = new Map<string, GuestCallLogEntry>()
    for (const [identity, json] of Object.entries(raw)) {
      try {
        map.set(identity, JSON.parse(json) as GuestCallLogEntry)
      } catch {
        /* skip corrupt entry */
      }
    }
    return map
  }
  return new Map(mem.get(roomId) ?? [])
}

async function writeEntry(roomId: string, entry: GuestCallLogEntry): Promise<void> {
  const r = getRedis()
  if (r) {
    const key = `${KEY_PREFIX}${roomId}`
    await r.hset(key, entry.identity, JSON.stringify(entry))
    await r.expire(key, LOG_TTL_S)
    return
  }
  const map = mem.get(roomId) ?? new Map<string, GuestCallLogEntry>()
  map.set(entry.identity, entry)
  mem.set(roomId, map)
}

export async function recordGuestJoined(
  roomId: string,
  identity: string,
  nick: string
): Promise<void> {
  await writeEntry(roomId, {
    identity,
    nick,
    joined_at: new Date().toISOString(),
  })
}

export async function recordGuestLeft(
  roomId: string,
  identity: string,
  kicked = false
): Promise<void> {
  const all = await readAll(roomId)
  const entry = all.get(identity)
  if (!entry) return
  await writeEntry(roomId, {
    ...entry,
    left_at: entry.left_at ?? new Date().toISOString(),
    ...(kicked ? { kicked: true } : {}),
  })
}

/** Is this identity a currently-logged guest of the room? (for webhook re-kick) */
export async function isLoggedGuest(
  roomId: string,
  identity: string
): Promise<boolean> {
  const all = await readAll(roomId)
  return all.has(identity)
}

/** Read-and-clear, for merging into call_sessions.guests on room_finished. */
export async function drainGuestCallLog(
  roomId: string
): Promise<GuestCallLogEntry[]> {
  const r = getRedis()
  if (r) {
    const key = `${KEY_PREFIX}${roomId}`
    const raw = await r.hgetall(key)
    await r.del(key)
    const out: GuestCallLogEntry[] = []
    for (const json of Object.values(raw)) {
      try {
        out.push(JSON.parse(json) as GuestCallLogEntry)
      } catch {
        /* skip */
      }
    }
    return out
  }
  const map = mem.get(roomId)
  mem.delete(roomId)
  return map ? [...map.values()] : []
}

/** Test hook. */
export function _resetGuestCallLogForTests(): void {
  mem.clear()
}

/**
 * PROJECT 13 :: GROUP_CALL_ROOM_REGISTRY (Redis-backed)
 * Level: Session Layer (Mesh Coordination)
 *
 * Room state stored in Redis — survives server restarts and horizontal scale-out.
 *
 * Key layout:
 *   group-call:room:{roomId}        HASH  userId → JSON<GroupCallParticipant>  TTL 8h
 *   group-call:user:{userId}:rooms  SET   roomId membership index               TTL 8h
 *
 * Redis is required for group calls. If REDIS_URL is unset the functions return
 * empty/no-op results so the server still boots, but group calls won't work.
 */

import { getRedis } from '../lib/redis.js'
import type { Redis } from 'ioredis'

export type GroupCallParticipant = {
  userId: string
  username: string
  joinedAt: number
  isMuted: boolean
  isVideoOff: boolean
}

const ROOM_TTL = 28_800 // 8 hours in seconds
const roomKey = (roomId: string) => `group-call:room:${roomId}`
const userRoomsKey = (userId: string) => `group-call:user:${userId}:rooms`

function redis(): Redis | null {
  return getRedis()
}

function parseParticipant(raw: string): GroupCallParticipant | null {
  try { return JSON.parse(raw) as GroupCallParticipant } catch { return null }
}

/** Get all participants in a group call room. */
export async function getRoomParticipants(roomId: string): Promise<GroupCallParticipant[]> {
  const r = redis()
  if (!r) return []
  const hash = await r.hgetall(roomKey(roomId))
  if (!hash) return []
  return Object.values(hash)
    .map(parseParticipant)
    .filter((p): p is GroupCallParticipant => p !== null)
}

/** Get the user IDs of all participants in a room. */
export async function getRoomParticipantIds(roomId: string): Promise<string[]> {
  const r = redis()
  if (!r) return []
  return r.hkeys(roomKey(roomId))
}

/** Check if a room has an active call. */
export async function isRoomActive(roomId: string): Promise<boolean> {
  const r = redis()
  if (!r) return false
  return (await r.hlen(roomKey(roomId))) > 0
}

/** Check if a user is in a specific room. */
export async function isUserInRoom(roomId: string, userId: string): Promise<boolean> {
  const r = redis()
  if (!r) return false
  return (await r.hexists(roomKey(roomId), userId)) === 1
}

/** Add a user to a group call room. Returns current participant list (including the new user). */
export async function joinRoom(
  roomId: string,
  userId: string,
  username: string
): Promise<GroupCallParticipant[]> {
  const r = redis()
  if (!r) return []
  const key = roomKey(roomId)

  const existing = await r.hget(key, userId)
  if (!existing) {
    const participant: GroupCallParticipant = {
      userId,
      username,
      joinedAt: Date.now(),
      isMuted: false,
      isVideoOff: false,
    }
    await r.hset(key, userId, JSON.stringify(participant))
    await r.sadd(userRoomsKey(userId), roomId)
  }

  // Refresh TTL on every join
  await r.expire(key, ROOM_TTL)
  await r.expire(userRoomsKey(userId), ROOM_TTL)

  return getRoomParticipants(roomId)
}

/** Remove a user from a group call room. Cleans up empty rooms. Returns remaining participants. */
export async function leaveRoom(roomId: string, userId: string): Promise<GroupCallParticipant[]> {
  const r = redis()
  if (!r) return []
  const key = roomKey(roomId)

  await r.hdel(key, userId)
  await r.srem(userRoomsKey(userId), roomId)

  const remaining = await getRoomParticipants(roomId)
  if (remaining.length === 0) {
    await r.del(key)
  }
  return remaining
}

/** Remove a user from ALL rooms they are in. Returns array of [roomId, remainingParticipants]. */
export async function leaveAllRooms(
  userId: string
): Promise<Array<[string, GroupCallParticipant[]]>> {
  const r = redis()
  if (!r) return []
  const roomIds = await r.smembers(userRoomsKey(userId))
  await r.del(userRoomsKey(userId))

  const results: Array<[string, GroupCallParticipant[]]> = []
  for (const roomId of roomIds) {
    const remaining = await leaveRoom(roomId, userId)
    results.push([roomId, remaining])
  }
  return results
}

/** Update mute/video state for a participant. */
export async function updateParticipantState(
  roomId: string,
  userId: string,
  patch: { isMuted?: boolean; isVideoOff?: boolean }
): Promise<void> {
  const r = redis()
  if (!r) return
  const key = roomKey(roomId)
  const raw = await r.hget(key, userId)
  if (!raw) return
  const participant = parseParticipant(raw)
  if (!participant) return

  if (patch.isMuted !== undefined) participant.isMuted = patch.isMuted
  if (patch.isVideoOff !== undefined) participant.isVideoOff = patch.isVideoOff

  await r.hset(key, userId, JSON.stringify(participant))
  await r.expire(key, ROOM_TTL)
}

/** Get all active room IDs (for diagnostics). */
export async function getActiveRoomIds(): Promise<string[]> {
  const r = redis()
  if (!r) return []
  const keys = await r.keys('group-call:room:*')
  return keys.map(k => k.replace('group-call:room:', ''))
}

/** Get participant count for a room. */
export async function getRoomSize(roomId: string): Promise<number> {
  const r = redis()
  if (!r) return 0
  return r.hlen(roomKey(roomId))
}

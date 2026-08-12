// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Per-call E2EE session id + room-key derivation, shared between the member
// token path (routes/call.ts) and the guest grant path (routes/guest.ts) so an
// approved guest receives EXACTLY the key current participants are using.
//
// TRUST BOUNDARY (do not overstate this as E2EE): the key is an HMAC of the
// server-held LIVEKIT_API_SECRET, so the application server CAN reconstruct it
// and decrypt group-call media. It protects media against a passive
// SFU/network observer only — see backlog N11 for true E2E-vs-server keys.

import { createHmac, randomUUID } from 'node:crypto'
import { getRedis } from './redis.js'

/** No-Redis fallback (single-node dev only). */
const callSessionFallback = new Map<string, string>()

/**
 * Get (or lazily create) the per-call session id for a room. The id lives in
 * Redis under `call:session:{roomId}` and is deleted when the room empties
 * (LiveKit `room_finished` webhook / mesh `group_call:leave`), so the next
 * call in the same room derives a fresh key.
 */
export async function getOrCreateCallSessionId(
  roomId: string,
  ttlSeconds: number
): Promise<string> {
  const redisKey = `call:session:${roomId}`
  const redis = getRedis()
  if (redis) {
    const existing = await redis.get(redisKey)
    if (existing) return existing
    const id = randomUUID()
    await redis.set(redisKey, id, 'EX', ttlSeconds)
    return id
  }
  const cached = callSessionFallback.get(roomId)
  if (cached) return cached
  const id = randomUUID()
  callSessionFallback.set(roomId, id)
  return id
}

export async function dropCallSession(roomId: string): Promise<void> {
  const redis = getRedis()
  if (redis) {
    await redis.del(`call:session:${roomId}`)
    return
  }
  callSessionFallback.delete(roomId)
}

export function deriveCallE2eeKey(
  apiSecret: string,
  roomId: string,
  callSessionId: string
): string {
  return createHmac('sha256', apiSecret)
    .update(`e2ee:${roomId}:${callSessionId}`)
    .digest('base64')
}

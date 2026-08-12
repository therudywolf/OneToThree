// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Server-side LiveKit administration for guest calls: token signing shared
// with routes/guest.ts, RoomService kick (twirp over HTTP), and the kicked-
// identity denylist that makes a kick stick even while the guest still holds
// an unexpired room JWT (LiveKit has no ban list — a kicked participant can
// reconnect with the same token, so the webhook re-removes denylisted
// identities on `participant_joined`).

import { createHmac } from 'node:crypto'
import { getRedis } from './redis.js'
import { readSecret } from './read-secret.js'

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function signLivekitToken(
  apiKey: string,
  apiSecret: string,
  payload: Record<string, unknown>
): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerEnc = b64url(JSON.stringify(header))
  const payloadEnc = b64url(JSON.stringify(payload))
  const signingInput = `${headerEnc}.${payloadEnc}`
  const sig = createHmac('sha256', apiSecret).update(signingInput).digest()
  return `${signingInput}.${b64url(sig)}`
}

/** wss://livekit.host → https://livekit.host (twirp endpoint base). */
export function livekitHttpUrl(): string | null {
  const raw = process.env.LIVEKIT_URL?.trim()
  if (!raw) return null
  return raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
}

/**
 * Remove a participant from a LiveKit room via RoomService. Returns false on
 * any failure (missing config, network, non-2xx) — callers treat the kick
 * denylist as the durable half and this call as best-effort acceleration.
 */
export async function removeLivekitParticipant(
  room: string,
  identity: string
): Promise<boolean> {
  const apiKey = readSecret('LIVEKIT_API_KEY')
  const apiSecret = readSecret('LIVEKIT_API_SECRET')
  const base = livekitHttpUrl()
  if (!apiKey || !apiSecret || !base) return false
  const now = Math.floor(Date.now() / 1000)
  const token = signLivekitToken(apiKey, apiSecret, {
    iss: apiKey,
    sub: 'onetothree-server',
    nbf: now - 5,
    exp: now + 60,
    video: { room, roomAdmin: true },
  })
  try {
    const res = await fetch(`${base}/twirp/livekit.RoomService/RemoveParticipant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ room, identity }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ─── Kicked-identity denylist ────────────────────────────────────────────────

const KICK_PREFIX = 'fm:guest:kicked:'
/** Outlives the longest possible guest room JWT (2h) with margin. */
const KICK_TTL_S = 60 * 60 * 5

const memKicked = new Map<string, number>()

export async function denyGuestIdentity(
  room: string,
  identity: string
): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.set(`${KICK_PREFIX}${room}:${identity}`, '1', 'EX', KICK_TTL_S)
    return
  }
  memKicked.set(`${room}:${identity}`, Date.now() + KICK_TTL_S * 1000)
}

export async function isGuestIdentityDenied(
  room: string,
  identity: string
): Promise<boolean> {
  const r = getRedis()
  if (r) {
    return (await r.exists(`${KICK_PREFIX}${room}:${identity}`)) === 1
  }
  const exp = memKicked.get(`${room}:${identity}`)
  if (!exp) return false
  if (Date.now() > exp) {
    memKicked.delete(`${room}:${identity}`)
    return false
  }
  return true
}

/** Test hook. */
export function _resetLivekitAdminForTests(): void {
  memKicked.clear()
}

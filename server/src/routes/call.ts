/**
 * LiveKit SFU token issuer.
 *
 * Tokens are HS256 JWTs with LiveKit's canonical `video` grant:
 *   { iss: apiKey, sub: userId, nbf, exp, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } }
 *
 * Configuration is read via the Docker-secrets-first pattern:
 *
 *   LIVEKIT_API_KEY_FILE     → /run/secrets/livekit_api_key      (preferred)
 *   LIVEKIT_API_SECRET_FILE  → /run/secrets/livekit_api_secret   (preferred)
 *   LIVEKIT_API_KEY          → plaintext env fallback (dev only)
 *   LIVEKIT_API_SECRET       → plaintext env fallback (dev only)
 *   LIVEKIT_URL              → public WSS URL, not a secret, plain env.
 *
 * If any of the three is missing the route returns 503 so the client can
 * fall back to the mesh WebRTC path. This intentional fail-open keeps the
 * messenger usable when LiveKit is not yet deployed.
 */
import { createHmac } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { callSessions, chatMembers, guestInvites, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import { getCallMediaMode } from '../lib/call-media-mode.js'
import { verifyLivekitWebhook } from '../lib/livekit-webhook.js'
import {
  deriveCallE2eeKey,
  dropCallSession,
  getOrCreateCallSessionId,
} from '../lib/call-e2ee-session.js'
import {
  isGuestIdentityDenied,
  removeLivekitParticipant,
} from '../lib/livekit-admin.js'
import { drainGuestCallLog, recordGuestLeft } from '../lib/guest-call-log.js'

const tokenBodySchema = z.object({
  room: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_\-:.]+$/),
  can_publish: z.boolean().optional().default(true),
  can_subscribe: z.boolean().optional().default(true),
})

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function signLivekitToken(
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

/** Default LiveKit token / E2EE-session lifetime: 2h, ample for a long call. */
const DEFAULT_CALL_TOKEN_TTL_SECONDS = 60 * 60 * 2
/** Hard ceiling so an operator override cannot recreate the 6h+ stale-key window. */
const MAX_CALL_TOKEN_TTL_SECONDS = 60 * 60 * 4

/**
 * Resolve the LiveKit token TTL (seconds), bounded to the expected call
 * duration. Operators may tune `LIVEKIT_TOKEN_TTL_SECONDS` but the value is
 * clamped to [5min, {@link MAX_CALL_TOKEN_TTL_SECONDS}] so the E2EE room key
 * cannot outlive a real call by hours (D20).
 */
export function resolveCallTokenTtlSeconds(): number {
  const raw = Number.parseInt(process.env.LIVEKIT_TOKEN_TTL_SECONDS ?? '', 10)
  if (!Number.isFinite(raw)) return DEFAULT_CALL_TOKEN_TTL_SECONDS
  return Math.max(60 * 5, Math.min(raw, MAX_CALL_TOKEN_TTL_SECONDS))
}

function resolveAuthorizedRoomId(room: string): string | null {
  const candidate = room.includes(':') ? room.slice(room.lastIndexOf(':') + 1) : room
  return z.string().uuid().safeParse(candidate).success ? candidate : null
}

export const callRoutes: FastifyPluginAsync = async (app) => {
  // LiveKit posts webhooks with Content-Type: application/webhook+json. The body
  // hash inside the signing JWT is computed over the *raw* bytes, so we must
  // preserve them verbatim rather than re-serialize a parsed object. This parser
  // is encapsulated to this plugin and stores the raw string on req.body.
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body)
    }
  )

  app.post('/call/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return

    const parsed = tokenBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'BAD_BODY' })
    }

    const roomId = resolveAuthorizedRoomId(parsed.data.room)
    if (!roomId) {
      return reply.status(400).send({ error: 'ROOM_NOT_AUTHORIZABLE' })
    }
    const [membership] = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, roomId), eq(chatMembers.userId, u.id)))
      .limit(1)
    if (!membership) {
      // Standalone guest-call rooms (docs/project/GUEST_MODE_CONCEPT.ru.md
      // §3.1) are NOT chats — the creator of a live guest link for this room
      // is authorized to join their own room; everyone else still 403s.
      // Guests never reach this route at all (their grant arrives via the
      // knock poll); this branch is for the CREATOR's side of the room.
      let standaloneOk = false
      if (req.server.featureFlags.guests) {
        const [inviteRow] = await db
          .select({ id: guestInvites.id })
          .from(guestInvites)
          .where(
            and(
              eq(guestInvites.roomId, roomId),
              eq(guestInvites.createdBy, u.id),
              isNull(guestInvites.revokedAt)
            )
          )
          .limit(1)
        standaloneOk = Boolean(inviteRow)
      }
      if (!standaloneOk) {
        return reply.status(403).send({ error: 'NOT_A_MEMBER' })
      }
    }

    const apiKey = readSecret('LIVEKIT_API_KEY')
    const apiSecret = readSecret('LIVEKIT_API_SECRET')
    const livekitUrl = process.env.LIVEKIT_URL?.trim()
    if (getCallMediaMode() !== 'self_hosted' || !apiKey || !apiSecret || !livekitUrl) {
      return reply.status(503).send({ error: 'LIVEKIT_NOT_CONFIGURED' })
    }
    if (apiSecret.length < 32) {
      return reply.status(503).send({ error: 'LIVEKIT_SECRET_TOO_SHORT' })
    }

    const now = Math.floor(Date.now() / 1000)
    // D20: bound the token TTL to the expected call duration. A 6h token meant a
    // former member's E2EE key (derived below, same Redis session) stayed valid
    // far past any real call. 2h is ample for a long call; the client re-fetches
    // a fresh token (and re-derives the room key) if a call somehow runs longer.
    const ttlSeconds = resolveCallTokenTtlSeconds()

    // `name` claim: LiveKit renders participants by identity (a bare UUID)
    // when the token carries no name — the SFU-mode name merge over app-WS is
    // disabled, so without this claim remote tiles show `id.slice(0,8)`.
    const [profile] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, u.id))
      .limit(1)

    const token = signLivekitToken(apiKey, apiSecret, {
      iss: apiKey,
      sub: u.id,
      nbf: now - 5,
      exp: now + ttlSeconds,
      jti: `${u.id}.${roomId}.${now}`,
      name: profile?.displayName?.trim() || u.username,
      metadata: JSON.stringify({ guest: false }),
      video: {
        room: roomId,
        roomJoin: true,
        canPublish: parsed.data.can_publish,
        canSubscribe: parsed.data.can_subscribe,
        canPublishData: true,
      },
    })

    // Derive the LiveKit Insertable-Streams room key from the API secret + room
    // ID + a per-session UUID (cached in Redis, deleted when the room empties —
    // see ws.ts group_call:leave — so the next call in a room gets a fresh key).
    //
    // TRUST BOUNDARY (do not overstate this as E2EE): the key is an HMAC of the
    // server-held LIVEKIT_API_SECRET, so the application server CAN reconstruct
    // it and decrypt group-call media. This protects media against a passive
    // SFU/network observer that lacks the secret — it is NOT end-to-end against
    // the server (unlike the 1:1 path, whose keys are ECDH-derived per peer and
    // never seen by the server). True E2E-vs-server group calls require deriving
    // the room key from participant ECDH material — tracked as backlog N11.
    // D16/D20: bound the session key to the token window (+ a short grace) rather
    // than a fixed 8h. The authoritative teardown is the LiveKit `room_finished`
    // webhook (below) which deletes this key the moment the room empties, giving
    // the next call a fresh room key. The TTL is only the safety net for a missed
    // webhook. Shared with the guest grant path (lib/call-e2ee-session.ts) so an
    // approved guest receives the exact key current participants use.
    const callSessionId = await getOrCreateCallSessionId(roomId, ttlSeconds + 60 * 5)
    const e2eeKey = deriveCallE2eeKey(apiSecret, roomId, callSessionId)

    reply.header('Cache-Control', 'no-store')
    return reply.send({
      token,
      url: livekitUrl,
      room: roomId,
      ttl_seconds: ttlSeconds,
      call_e2ee_key: e2eeKey,
    })
  })

  app.get('/call/config', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return
    const cfgKey = readSecret('LIVEKIT_API_KEY')
    const cfgSecret = readSecret('LIVEKIT_API_SECRET')
    const mediaMode = getCallMediaMode()
    return reply.send({
      media_mode: mediaMode,
      origin_safe: mediaMode === 'origin_safe',
      livekit_enabled: mediaMode === 'self_hosted' && Boolean(cfgKey && cfgSecret && process.env.LIVEKIT_URL),
      livekit_url: process.env.LIVEKIT_URL ?? null,
      mesh_fallback_enabled: mediaMode === 'self_hosted',
      group_relay_enabled: mediaMode === 'origin_safe',
    })
  })

  /**
   * POST /call/livekit/webhook — LiveKit server webhook sink.
   *
   * D16/D20: In LiveKit mode the mesh `group_call:leave` (which tore down the
   * `call:session:${roomId}` Redis key) is never sent, so the per-call E2EE room
   * key persisted for its full TTL and never rotated — a former member who
   * cached the key could decrypt a *later* call in the same room. LiveKit fires
   * `room_finished` the moment a room empties; we delete the session key here so
   * the next call in that room derives a fresh key.
   *
   * Auth is the LiveKit webhook signature (HS256 JWT over the raw body, signed
   * with the API secret) — there is no user session. We always return 200 for
   * authenticated-but-uninteresting events so LiveKit does not retry.
   */
  app.post(
    '/call/livekit/webhook',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const apiKey = readSecret('LIVEKIT_API_KEY')
      const apiSecret = readSecret('LIVEKIT_API_SECRET')
      if (!apiKey || !apiSecret) {
        return reply.status(503).send({ error: 'LIVEKIT_NOT_CONFIGURED' })
      }

      const rawBody = typeof req.body === 'string' ? req.body : ''
      const result = verifyLivekitWebhook(
        req.headers.authorization,
        rawBody,
        apiKey,
        apiSecret
      )
      if (!result.ok) {
        req.log.warn({ reason: result.reason }, 'livekit webhook rejected')
        return reply.status(401).send({ error: 'INVALID_WEBHOOK_SIGNATURE' })
      }

      const event = result.event
      const eventType = typeof event.event === 'string' ? event.event : null
      const room = event.room
      const roomName =
        room && typeof room === 'object' && typeof (room as { name?: unknown }).name === 'string'
          ? (room as { name: string }).name
          : null
      const roomId = roomName ? resolveAuthorizedRoomId(roomName) : null
      const participant = (event as { participant?: unknown }).participant
      const identity =
        participant &&
        typeof participant === 'object' &&
        typeof (participant as { identity?: unknown }).identity === 'string'
          ? (participant as { identity: string }).identity
          : null

      if (eventType === 'room_finished' && roomId) {
        try {
          await dropCallSession(roomId)
        } catch (err) {
          req.log.warn({ err, roomId }, 'livekit webhook: failed to drop call session key')
        }
        req.log.info({ roomId }, 'livekit room_finished: rotated call E2EE session')
        // Drain the per-room guest log into the chat's call history — the only
        // trace a bodiless call guest leaves. Standalone rooms have no
        // call_sessions row (they are not chats), so their entries just drop.
        try {
          const entries = await drainGuestCallLog(roomId)
          if (entries.length > 0) {
            const nowIso = new Date().toISOString()
            const closed = entries.map((e) => ({ ...e, left_at: e.left_at ?? nowIso }))
            const [sessionRow] = await db
              .select({ id: callSessions.id })
              .from(callSessions)
              .where(eq(callSessions.chatId, roomId))
              .orderBy(desc(callSessions.startedAt))
              .limit(1)
            if (sessionRow) {
              await db
                .update(callSessions)
                .set({
                  guests: sql`coalesce(${callSessions.guests}, '[]'::jsonb) || ${JSON.stringify(closed)}::jsonb`,
                })
                .where(eq(callSessions.id, sessionRow.id))
            }
          }
        } catch (err) {
          req.log.warn({ err, roomId }, 'livekit webhook: failed to persist guest call log')
        }
      }

      // A kicked guest can reconnect on their still-valid room JWT (LiveKit
      // has no ban list) — re-remove denylisted identities the moment the SFU
      // reports them back in.
      if (eventType === 'participant_joined' && roomId && identity?.startsWith('guest:')) {
        if (await isGuestIdentityDenied(roomId, identity)) {
          void removeLivekitParticipant(roomId, identity)
        }
      }
      if (eventType === 'participant_left' && roomId && identity?.startsWith('guest:')) {
        try {
          await recordGuestLeft(roomId, identity)
        } catch (err) {
          req.log.warn({ err, roomId }, 'livekit webhook: failed to record guest leave')
        }
      }

      return reply.status(200).send({ ok: true })
    }
  )
}

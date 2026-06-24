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
import { createHmac, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import { getRedis } from '../lib/redis.js'
import { getCallMediaMode } from '../lib/call-media-mode.js'

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

const callSessionFallback = new Map<string, string>()

function resolveAuthorizedRoomId(room: string): string | null {
  const candidate = room.includes(':') ? room.slice(room.lastIndexOf(':') + 1) : room
  return z.string().uuid().safeParse(candidate).success ? candidate : null
}

export const callRoutes: FastifyPluginAsync = async (app) => {
  app.post('/call/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return

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
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
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
    const ttlSeconds = 60 * 60 * 6 // 6 hours — ample for a long call.

    const token = signLivekitToken(apiKey, apiSecret, {
      iss: apiKey,
      sub: u.id,
      nbf: now - 5,
      exp: now + ttlSeconds,
      jti: `${u.id}.${roomId}.${now}`,
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
    const redisKey = `call:session:${roomId}`
    const redis = getRedis()
    const CALL_SESSION_TTL = 60 * 60 * 8 // 8 hours
    let callSessionId: string
    if (redis) {
      const existing = await redis.get(redisKey)
      if (existing) {
        callSessionId = existing
      } else {
        callSessionId = randomUUID()
        await redis.set(redisKey, callSessionId, 'EX', CALL_SESSION_TTL)
      }
    } else {
      // No Redis — fall back to a per-process map (single-node dev only)
      callSessionId = callSessionFallback.get(roomId) ?? (() => {
        const id = randomUUID()
        callSessionFallback.set(roomId, id)
        return id
      })()
    }
    const e2eeKey = createHmac('sha256', apiSecret)
      .update(`e2ee:${roomId}:${callSessionId}`)
      .digest('base64')

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
    if (!u || !assertAuthed(reply, u)) return
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
}

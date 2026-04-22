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
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import { getRedis } from '../lib/redis.js'

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

export const callRoutes: FastifyPluginAsync = async (app) => {
  app.post('/call/token', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return

    const parsed = tokenBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'BAD_BODY' })
    }

    const apiKey = readSecret('LIVEKIT_API_KEY')
    const apiSecret = readSecret('LIVEKIT_API_SECRET')
    const livekitUrl = process.env.LIVEKIT_URL?.trim()
    if (!apiKey || !apiSecret || !livekitUrl) {
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
      jti: `${u.id}.${parsed.data.room}.${now}`,
      video: {
        room: parsed.data.room,
        roomJoin: true,
        canPublish: parsed.data.can_publish,
        canSubscribe: parsed.data.can_subscribe,
        canPublishData: true,
      },
    })

    // Derive E2EE room key from the API secret + room ID + per-session UUID.
    // The session UUID is stored in Redis with a TTL so each call activation
    // gets a fresh key (forward secrecy: former participants cannot decrypt
    // future calls in the same room).
    const redisKey = `call:session:${parsed.data.room}`
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
      callSessionId = callSessionFallback.get(parsed.data.room) ?? (() => {
        const id = randomUUID()
        callSessionFallback.set(parsed.data.room, id)
        return id
      })()
    }
    const e2eeKey = createHmac('sha256', apiSecret)
      .update(`e2ee:${parsed.data.room}:${callSessionId}`)
      .digest('base64')

    reply.header('Cache-Control', 'no-store')
    return reply.send({
      token,
      url: livekitUrl,
      room: parsed.data.room,
      ttl_seconds: ttlSeconds,
      call_e2ee_key: e2eeKey,
    })
  })

  app.get('/call/config', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return
    const cfgKey = readSecret('LIVEKIT_API_KEY')
    const cfgSecret = readSecret('LIVEKIT_API_SECRET')
    return reply.send({
      livekit_enabled: Boolean(cfgKey && cfgSecret && process.env.LIVEKIT_URL),
      livekit_url: process.env.LIVEKIT_URL ?? null,
    })
  })
}

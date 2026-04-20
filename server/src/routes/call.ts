/**
 * LiveKit SFU token issuer.
 *
 * Tokens are HS256 JWTs with LiveKit's canonical `video` grant:
 *   { iss: apiKey, sub: userId, nbf, exp, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } }
 *
 * Configuration (`.env.prod`):
 *   LIVEKIT_API_KEY    — LiveKit server API key (starts with "APIxxx").
 *   LIVEKIT_API_SECRET — LiveKit server API secret (32–64 chars).
 *   LIVEKIT_URL        — public WSS URL, e.g. wss://lk.onetothree.ru
 *
 * If any of the three is missing the route returns 503 so the client can
 * fall back to the mesh WebRTC path. This intentional fail-open keeps the
 * messenger usable when LiveKit is not yet deployed.
 */
import { createHmac } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

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

export const callRoutes: FastifyPluginAsync = async (app) => {
  app.post('/call/token', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return

    const parsed = tokenBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'BAD_BODY' })
    }

    const apiKey = process.env.LIVEKIT_API_KEY?.trim()
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim()
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

    reply.header('Cache-Control', 'no-store')
    return reply.send({
      token,
      url: livekitUrl,
      room: parsed.data.room,
      ttl_seconds: ttlSeconds,
    })
  })

  app.get('/call/config', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return
    return reply.send({
      livekit_enabled: Boolean(
        process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL
      ),
      livekit_url: process.env.LIVEKIT_URL ?? null,
    })
  })
}
